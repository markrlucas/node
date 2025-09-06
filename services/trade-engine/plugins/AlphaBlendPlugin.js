const WebSocket = require('ws');
const trades = require('../../../models/pnlTrades');
const createPluginLogger = require('./pluginsLogger');
const connectDB = require('../../../includes/db')

const WebSocketClient = require('../../../includes/WebSocketClient');
const pm2events = require('../websockets/pm2events');
const orderStore = require('../orders/orderStore');
const { log } = require('../logger');
const { now } = require('mongoose');

// Initialize logger for AlphaBlendPlugin
const { logInfo, logWarn, logError } = createPluginLogger('AlphaBlendPlugin') || require('../logger');

class AlphaBlendPlugin {
  constructor(options = {}) {
    this.name = 'AlphaBlendPlugin';
    this.pluginAcronym = 'ABP';
    this.ws = null;
    this.klineWS = options.klineWS || null;
    this.symbol = options.symbol || null;
    this.duration = options.duration || '1m';
    this.limit = options.limit || 180;
    this.lastDecisionBroadcast = 0;

    this.broadcastClient = new WebSocketClient(options.broadcastClientWS || 'ws://localhost:8083');
    this.broadcastClient.on('open', () => { logInfo(`[${this.name}] Connected to broadcast server on port 8083.`); });
    this.broadcastClient.on('error', (error) => logError(`[${this.name}] Broadcast WebSocket error: ${error && error.stack ? error.stack : error}`));
    this.broadcastClient.on('close', () => logWarn(`[${this.name}] Broadcast WebSocket closed.`));

    // AlphaBlend-specific defaults and data (original trend calculations)
    this.alphaTrendData = {
      highs: [],
      lows: [],
      closes: [],
      volumes: [],
      atrValues: [],
      alphaTrendValues: [],
      useVolumeData: true,
      stickyTrend: true,
      length: options.length || 14,
      coeff: options.coeff || 1.0,
      trendReq: options.trendReq || 'Ranging',
      signalTolerance: options.signalTolerance || 0.005,
      referenceBarOffset: options.referenceBarOffset || 2
    };

    // New MA200-related data.
    this.ma200Data = {
      closes: [],
      period: options.ma200Period || 200,
      lastClose: null,
      lastMa200: null
    };

    // Signal tracking
    this.lastSignalAction = null;
    this.lastSignalTimestamp = null;
    this.lastSignalPrice = null;

    this.trades = {};
    this.clientOrderId = null;
    this.tradeSold = 'STARTED'; // Track if the trade was sold or not, initialized to 'STARTED'
    this.marketCondition = null;
    this.indicatorCondition = null;
    this.isHistorical = false;

    logInfo(`[${this.name}] Constructed with options: ${JSON.stringify(options)}`);
  }

  initializeWebSocket(klineWS) {
    if (klineWS) this.klineWS = klineWS;
    if (!this.klineWS) {
      logError(`[${this.name} - ${this.symbol}] klineWS not provided. Cannot initialize WebSocket.`);
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      logWarn(`[${this.name} - ${this.symbol}] WebSocket already open, skipping re-initialization.`);
      return;
    }
    this.ws = new WebSocket(this.klineWS);

    this.ws.on('open', () => {
      logInfo(`[${this.name} - ${this.symbol}] WebSocket connected: ${this.klineWS}`);
    });

    this.ws.on('message', (Kline) => {
      const klineStr = (typeof Kline === 'string') ? Kline : Kline.toString('utf8');
      //logInfo(`[${this.name} - ${this.symbol}] Received kline: ${klineStr.length > 200 ? klineStr.substring(0,200) + '...' : klineStr}`);
      if (klineStr.includes('kline')) {
        const klineData = JSON.parse(klineStr);
        if (klineData.k.x === true) {
        //  logInfo(`[${this.name} - ${this.symbol}] Processing finalized kline at ${klineData.k.t}: close=${klineData.k.c}`);
          this.processWebSocketMessage(klineData.k);
        }
        return;
      }
    });

    this.ws.on('close', () => {
      logWarn(`[${this.name} - ${this.symbol}] WebSocket closed. Reconnecting in 5 seconds...`);
      setTimeout(() => this.initializeWebSocket(), 5000);
    });

    this.ws.on('error', (error) => logError(`[${this.name} - ${this.symbol}] WebSocket error: ${error && error.stack ? error.stack : error}`));
  }

  broadcastSignal(signalData) {
    const message = {
      type: 'signal',
      data: signalData,
      timestamp: Date.now()
    };
    logInfo(`[${this.name} - ${this.symbol}] Broadcasting signal: ${JSON.stringify(signalData)}`);
    this.broadcastClient.send(message);
  }

  processWebSocketMessage(klineData) {
    try {
      logInfo(`[${this.name} - ${this.symbol}] Entering processWebSocketMessage with data: ${JSON.stringify(klineData)}`);
      this.processNewPriceData(klineData, false);
    } catch (error) {
      logError(`[${this.name} - ${this.symbol}] Error processing message: ${error && error.stack ? error.stack : error}`);
    }
  }

  async processAggregatedCandle(aggregatedCandle) {
    logInfo(`[${this.name} - ${this.symbol}] Processing aggregated candle: ${JSON.stringify(aggregatedCandle)}`);
    await this.processNewPriceData({ c: aggregatedCandle.close, h: aggregatedCandle.high, l: aggregatedCandle.low, t: aggregatedCandle.timestamp, v: aggregatedCandle.volume }, false);
  }

  async processNewPriceData({ c: price, h: high, l: low, t: timestamp, v: volume }) {

    // Calculate if the data is historical and log detailed info for debugging.
    const currentTime = Date.now();
    const diff = currentTime - timestamp;
    // Set isHistorical to true if the difference is greater than 3 seconds.
    this.isHistorical = diff > 60300; // 60 seconds + 3 seconds buffer
    const convertToBST = (ts) =>
      new Date(ts).toLocaleString('en-GB', {
      timeZone: 'Europe/London',
      hour12: false,
      timeZoneName: 'short'
      });

    const currentUkTime = convertToBST(currentTime);
    const providedUkTime = convertToBST(timestamp);
    logInfo(
      `[${this.name} - ${this.symbol}] UK BST time conversion: current=${currentUkTime}, provided=${providedUkTime}`
    );
    logInfo(`[${this.name} - ${this.symbol}] Timestamp debugging: currentTime=${currentTime}, provided timestamp=${timestamp}, difference=${diff}ms, isHistorical=${this.isHistorical}`);
    
    //return;

    logInfo(`[${this.name} - ${this.symbol}] Processing new price data: close=${price} high=${high} low=${low} volume=${volume} timestamp=${timestamp}`);

    // Parse values
    const parsedHigh = parseFloat(high), parsedLow = parseFloat(low), parsedPrice = parseFloat(price);
    const parsedVolume = volume ? parseFloat(volume) : 0;

    // Update AlphaBlend trend data.
    this.alphaTrendData.highs.push(parsedHigh);
    this.alphaTrendData.lows.push(parsedLow);
    this.alphaTrendData.closes.push(parsedPrice);
    this.alphaTrendData.volumes.push(parsedVolume);
    if (this.alphaTrendData.highs.length > this.alphaTrendData.length) {
      this.alphaTrendData.highs.shift();
      this.alphaTrendData.lows.shift();
      this.alphaTrendData.closes.shift();
      this.alphaTrendData.volumes.shift();
    }

    // Update 200MA data.
    if (!this.ma200Data.closes) this.ma200Data.closes = [];
    this.ma200Data.closes.push(parsedPrice);
    if (this.ma200Data.closes.length > this.ma200Data.period) {
      this.ma200Data.closes.shift();
    }

    // Calculate 200MA when enough data exists.
    let ma200Signal = 'HOLD';
    let ma200Reason = 'Insufficient data for MA200 calculation';
    let ma200Value = null;
    if (this.ma200Data.closes.length >= this.ma200Data.period) {
      const sum200 = this.ma200Data.closes.reduce((acc, val) => acc + val, 0);
      ma200Value = sum200 / this.ma200Data.period;
      if (this.ma200Data.lastClose !== null && this.ma200Data.lastMa200 !== null) {
        if (this.ma200Data.lastClose < this.ma200Data.lastMa200 && parsedPrice >= ma200Value) {
          ma200Signal = 'BUY';
          ma200Reason = `Price crossed above MA200`;
        } else if (this.ma200Data.lastClose > this.ma200Data.lastMa200 && parsedPrice <= ma200Value) {
          ma200Signal = 'SELL';
          ma200Reason = `Price crossed below MA200`;
        } else {
          ma200Signal = 'HOLD';
          ma200Reason = `No MA200 crossover detected`;
        }
      } else {
        ma200Signal = 'HOLD';
        ma200Reason = `Initial MA200 calculated: ${ma200Value.toFixed(3)}`;
      }
      this.ma200Data.lastClose = parsedPrice;
      this.ma200Data.lastMa200 = ma200Value;
    }

    // Only proceed with decision-making if we have enough alphaTrend data.
    if (this.alphaTrendData.highs.length >= this.alphaTrendData.length) {
      const decision = await this.makeDecision({ price, high, low, t: timestamp });

      decision.price = price;
      decision.source = 'ws';
      // Attach the additional MA200 properties to the final decision.
      decision.ma200Signal = ma200Signal;
      decision.ma200Reason = ma200Reason;
      decision.ma200 = ma200Value !== null ? parseFloat(ma200Value.toFixed(3)) : 'N/A';

      logInfo(`[${this.name} - ${this.symbol}] Decision output: ${JSON.stringify(decision)}`);
      this.broadcastSignal(decision);
      return decision;
    } else {
      logInfo(`[${this.name} - ${this.symbol}] Not enough data for final calculation yet. Current count: ${this.alphaTrendData.highs.length}`);
      return {
        plugin: 'AlphaBlendPlugin',
        laction: this.lastSignalAction,
        tslactiondate: null,
        laprice: null,
        action: 'HOLD',
        price: parseFloat(price).toFixed(3),
        alphaTrend: null,
        reason: 'Not enough data',
        timestamp: timestamp,
        atr: null,
        upT: null,
        downT: null,
        indicatorValue: null,
        prevAlphaTrend: null,
        currentAlphaTrend: null,
        difference: null,
        ma200Signal: ma200Signal,
        ma200Reason: ma200Reason,
        ma200: ma200Value !== null ? parseFloat(ma200Value.toFixed(3)) : 'N/A'
      };
    }
  }

  static computeRSI(closes, period) {
    if (closes.length < period) return null;
    let gains = 0, losses = 0, avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const change = closes[i] - closes[i - 1];
      if (change >= 0) {
        gains += change;
      } else {
        losses += Math.abs(change);
      }
    }
    avgGain = gains / period;
    avgLoss = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      avgGain = ((avgGain * (period - 1)) + Math.max(0, change)) / period;
      avgLoss = ((avgLoss * (period - 1)) + Math.abs(Math.min(0, change))) / period;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  static computeMFI(highs, lows, closes, volumes, period) {
    if (closes.length < period) return null;
    let positiveFlow = 0, negativeFlow = 0;
    for (let i = closes.length - period + 1; i < closes.length; i++) {
      const typicalPricePrev = (highs[i - 1] + lows[i - 1] + closes[i - 1]) / 3;
      const typicalPriceCurr = (highs[i] + lows[i] + closes[i]) / 3;
      const moneyFlow = typicalPriceCurr * (volumes[i] || 0);
      if (typicalPriceCurr > typicalPricePrev) {
        positiveFlow += moneyFlow;
      } else if (typicalPriceCurr < typicalPricePrev) {
        negativeFlow += moneyFlow;
      } else {
        positiveFlow += moneyFlow / 2;
        negativeFlow += moneyFlow / 2;
      }
    }
    if (negativeFlow === 0) return 100;
    const moneyFlowRatio = positiveFlow / negativeFlow;
    return 100 - (100 / (1 + moneyFlowRatio));
  }

  async makeDecision({ price, high, low, t }) {
    try {
      if (this.alphaTrendData.highs.length < this.alphaTrendData.length) {
        throw new Error("Insufficient data");
      }
      const trueRanges = [];
      for (let i = 1; i < this.alphaTrendData.highs.length; i++) {
        const highLow = this.alphaTrendData.highs[i] - this.alphaTrendData.lows[i];
        const highClose = Math.abs(this.alphaTrendData.highs[i] - this.alphaTrendData.closes[i - 1]);
        const lowClose = Math.abs(this.alphaTrendData.lows[i] - this.alphaTrendData.closes[i - 1]);
        trueRanges.push(Math.max(highLow, highClose, lowClose));
      }

      const atr = trueRanges.reduce((sum, value) => sum + value, 0) / trueRanges.length;
      const highValue = parseFloat(high);
      const coeff = parseFloat(this.alphaTrendData.coeff) || 1.0;
      const upT = parseFloat(low) - (atr * coeff);
      const formattedUpT = parseFloat(upT.toFixed(5));
      const downT = highValue + (atr * coeff);
      const formattedDownT = parseFloat(downT.toFixed(5));
      const period = this.alphaTrendData.length;
      const novolumedata = !this.alphaTrendData.useVolumeData;

      let indValue = null;
      if (novolumedata) {
        const rsi = AlphaBlendPlugin.computeRSI(this.alphaTrendData.closes, period);
        indValue = rsi;
        this.indicatorCondition = rsi !== null ? (rsi >= 50) : false;
      } else {
        const mfi = AlphaBlendPlugin.computeMFI(
          this.alphaTrendData.highs,
          this.alphaTrendData.lows,
          this.alphaTrendData.closes,
          this.alphaTrendData.volumes,
          period
        );
        if (mfi === 100) {
          const rsi = AlphaBlendPlugin.computeRSI(this.alphaTrendData.closes, period);
          indValue = rsi;
          this.indicatorCondition = rsi !== null ? (rsi >= 50) : false;
        } else {
          indValue = mfi;
          this.indicatorCondition = mfi !== null ? (mfi >= 50) : false;
        }
      }

      const offset = this.alphaTrendData.referenceBarOffset;
      let prevAlphaTrend = this.alphaTrendData.alphaTrendValues.length > 0 ?
        this.alphaTrendData.alphaTrendValues[this.alphaTrendData.alphaTrendValues.length - 1] :
        this.indicatorCondition ? upT : downT;
      let alphaTrend;
      if (this.alphaTrendData.stickyTrend) {
        alphaTrend = this.indicatorCondition ? (upT < prevAlphaTrend ? prevAlphaTrend : upT) : (downT > prevAlphaTrend ? prevAlphaTrend : downT);
      } else {
        alphaTrend = this.indicatorCondition ? upT : downT;
      }
      this.alphaTrendData.alphaTrendValues.push(alphaTrend);
      let diff = null;
      if (this.alphaTrendData.alphaTrendValues.length >= offset + 1) {
        const len = this.alphaTrendData.alphaTrendValues.length;
        const refValue = this.alphaTrendData.alphaTrendValues[len - (offset + 1)];
        diff = alphaTrend - refValue;
      }
      let action = 'HOLD';
      let reason = 'No strong signal';

      if (this.alphaTrendData.alphaTrendValues.length >= offset + 1) {
        const len = this.alphaTrendData.alphaTrendValues.length;
        const refValue = this.alphaTrendData.alphaTrendValues[len - (offset + 1)];
        const prevValue = this.alphaTrendData.alphaTrendValues[len - offset];
        const currentValue = alphaTrend;
        const differenceStr = (currentValue - refValue).toFixed(5);

        if (prevValue <= refValue && currentValue > refValue) {

          action = 'BUY';
          reason = `AlphaTrend crossover: previous (${prevValue.toFixed(5)}) <= ${offset} bars ago (${refValue.toFixed(5)}) and current (${currentValue.toFixed(5)}) > ${offset} bars ago. Difference: ${differenceStr}`;

        } else if (prevValue >= refValue && currentValue < refValue) {

          action = 'SELL';
          reason = `AlphaTrend crossunder: previous (${prevValue.toFixed(5)}) >= ${offset} bars ago (${refValue.toFixed(5)}) and current (${currentValue.toFixed(5)}) < ${offset} bars ago. Difference: ${differenceStr}`;

        }
      }

      const signal = {
        plugin: 'AlphaBlendPlugin',
        symbol: this.symbol,
        laction: this.lastSignalAction,
        tslactiondate: t,
        laprice: this.lastSignalPrice,
        action,
        side: action,
        price: parseFloat(price).toFixed(3),
        clientOrderId: this.clientOrderId,
        alphaTrend,
        reason,
        timestamp: t,
        atr: atr,
        upT: formattedUpT,
        downT: formattedDownT,
        indicatorValue: indValue,
        marketCondition: this.indicatorCondition ? "Bullish" : "Bearish" || NA,
        prevAlphaTrend: prevAlphaTrend,
        currentAlphaTrend: alphaTrend,
        difference: diff,
        config: {
          useVolumeData: this.alphaTrendData.useVolumeData,
          stickyTrend: this.alphaTrendData.stickyTrend,
          length: this.alphaTrendData.length,
          coeff: this.alphaTrendData.coeff,
          trendReq: this.alphaTrendData.trendReq,
          signalTolerance: this.alphaTrendData.signalTolerance,
          referenceBarOffset: this.alphaTrendData.referenceBarOffset
        }
      };

      // REMEMBER - The time check will cause issues with backtesting if not handled properly.
      if (action === this.lastSignalAction || action === 'interHOLD' || this.isHistorical === true) {
        logInfo(`[${this.name} - ${this.symbol}] Decision already ${this.lastSignalAction}, or historical emitting interHOLD.`);
        return {
          plugin: 'AlphaBlendPlugin',
          symbol: this.symbol,
          laction: this.lastSignalAction,
          tslactiondate: this.lastSignalTimestamp,
          laprice: this.lastSignalPrice,
          action: 'interHOLD',
          price: parseFloat(price).toFixed(3),
          alphaTrend,
          reason: `Decision is already ${this.lastSignalAction} or data is historical. Emitting interHOLD.`,
          timestamp: t,
          atr: atr,
          upT: formattedUpT,
          downT: formattedDownT,
          indicatorValue: indValue,
          marketCondition: this.indicatorCondition ? "Bullish" : "Bearish" || NA,
          prevAlphaTrend: prevAlphaTrend,
          currentAlphaTrend: alphaTrend,
          difference: diff
        };
      }
      if (action === 'BUY') {
        logInfo(`[${this.name} - ${this.symbol}] BUY action triggered. Price: ${price}, AlphaTrend: ${alphaTrend}, reason: ${reason}`);

        if (this.tradeSold === true || this.tradeSold === 'STARTED') {
          this.clientOrderId = this.name.replace(/[^A-Z]/g, '') + Date.now().toString(16) + '_' + Math.floor(Math.random() * 9999 + 1).toString(16);
          logInfo(`[${this.name} - ${this.symbol}] New clientOrderId generated for BUY: ${this.clientOrderId}`);
        }
      } else if (action === 'SELL') {
        // const order = orderStore.getMatchingTrade(this.clientOrderId);
        const order = await trades.findOne({ clientOrderId: this.clientOrderId }).lean();

        logInfo(`[${this.name} - ${this.symbol}] ${order ? 'Order found' : 'No order found'} for clientOrderId: ${this.clientOrderId}. Checking profit to process SELL.`);
        
        if (order) {
          logInfo(`[${this.name} - ${this.symbol}] Order found for clientOrderId: ${this.clientOrderId}. Checking profit to process SELL.`);
          logInfo(`[${this.name} - ${this.symbol}] Order details: ${JSON.stringify(order)}`);

          const profitPrice = order.profitPrice;

          logWarn(`[${this.name} - ${this.symbol}] SELL action triggered. Price: ${price}.
            Order match: 
            ${JSON.stringify(order)}`);

          if (profitPrice && parseFloat(price) >= parseFloat(profitPrice)) {
            logInfo(`[${this.name} - ${this.symbol}] SELL action triggered. Price: ${price}, Profit Price: ${profitPrice}`);
            this.tradeSold = true;
            this.lastSignalAction = action;
            this.lastSignalTimestamp = t;
            this.lastSignalPrice = price;
            signal.clientOrderId = this.clientOrderId;
          } else {
            const fallbackProfitPrice = 'N/A'; // Define fallback value
            logWarn(`[${this.name} - ${this.symbol}] SELL action not triggered. Current price: ${price} is below profit price: ${profitPrice || fallbackProfitPrice}`);
            this.tradeSold = false;
            signal.action = 'interHOLD';
            signal.reason = `SELL action not triggered. Current price: ${price} is below profit price: ${profitPrice || fallbackProfitPrice}`;
          }
        } else {
          logWarn(`[${this.name} - ${this.symbol}] No order found for clientOrderId: ${this.clientOrderId}. Cannot process SELL.`);
          signal.action = 'interHOLD';
          signal.reason = `No order found for clientOrderId: ${this.clientOrderId}`;
          if (this.tradeSold === 'STARTED') {
            this.tradeSold = true; // Reset tradeSold if no order found
            signal.reason = ` No order found for clientOrderId: ${this.clientOrderId}, but trading was started.`;
          }
        }
      }

        this.lastSignalAction = action;
        this.lastSignalTimestamp = t;
        this.lastSignalPrice = price;
        signal.clientOrderId = this.clientOrderId;

      logInfo(`[${this.name} - ${this.symbol}] Final signal from this plugin. Signal: ${signal.action} | Price: ${signal.price}`);
      logInfo(`[${this.name} - ${this.symbol}] Final signal: ${JSON.stringify(signal)}`);
      return signal;

    } catch (error) {
      logError(`[${this.name} - ${this.symbol}] Error in makeDecision: ${error && error.stack ? error.stack : error}`);
      return {
        plugin: 'AlphaBlendPlugin',
        marketCondition: this.indicatorCondition ? "Bullish" : "Bearish" || NA,
        laction: this.lastSignalAction,
        tslactiondate: this.lastSignalTimestamp,
        laprice: this.lastSignalPrice,
        action: 'HOLD',
        price,
        alphaTrend: null,
        reason: 'Error calculating AlphaTrend',
        timestamp: t || new Date().toISOString()
      };
    }
  }

  updateParams(options = {}) {
    if (options.length !== undefined) {
      this.alphaTrendData.length = options.length;
      logInfo(`[${this.name} - ${this.symbol}] Length set to: ${options.length}`);
    }
    console.log(`[${this.name} - ${this.symbol}] Building URL with params -----> BEFORE OPTIONS: ${JSON.stringify(options)}`);
    if (options.WS) {
      const baseUrl = options.WS;
      console.log(`[${this.name} - ${this.symbol}] Building URL with params -----> BASEURL: ${baseUrl}`);
      const params = new URLSearchParams();
      if (options.symbol) {
        params.append('symbol', options.symbol);
        logInfo(`[${this.name} - ${this.symbol}] URL parameter set: symbol = ${options.symbol}`);
      }
      if (options.duration) {
        params.append('interval', options.duration);
        logInfo(`[${this.name} - ${this.symbol}] URL parameter set: interval = ${options.duration}`);
      }
      if (options.limit) {
        params.append('limit', options.limit);
        logInfo(`[${this.name} - ${this.symbol}] URL parameter set: limit = ${options.limit}`);
      }

      this.klineWS = `${baseUrl}?${params.toString()}`;
            
      console.log(`[${this.name} - ${this.symbol}] Building URL with params -----> NO WS WHY?????`);
    }
    if (options.coeff !== undefined) {
      this.alphaTrendData.coeff = options.coeff;
      logInfo(`[${this.name} - ${this.symbol}] Coefficient set to: ${options.coeff}`);
    }
    if (options.signalTolerance !== undefined) {
      this.alphaTrendData.signalTolerance = options.signalTolerance;
      logInfo(`[${this.name} - ${this.symbol}] Signal tolerance set to: ${options.signalTolerance}`);
    }
    if (options.referenceBarOffset !== undefined) {
      this.alphaTrendData.referenceBarOffset = options.referenceBarOffset;
      logInfo(`[${this.name} - ${this.symbol}] Reference bar offset set to: ${options.referenceBarOffset}`);
    }
    if (options.useVolumeData !== undefined) {
      this.alphaTrendData.useVolumeData = options.useVolumeData;
      logInfo(`[${this.name} - ${this.symbol}] Use volume data flag set to: ${options.useVolumeData}`);
    }
    if (options.stickyTrend !== undefined) {
      this.alphaTrendData.stickyTrend = options.stickyTrend;
      logInfo(`[${this.name} - ${this.symbol}] Sticky trend flag set to: ${options.stickyTrend}`);
    }
    if (options.klineWS) {
      this.klineWS = options.klineWS;
      logInfo(`[${this.name} - ${this.symbol}] klineWS set to: ${options.klineWS}`);
    }
    if (options.symbol) {
      this.symbol = options.symbol;
      logInfo(`[${this.name} - ${this.symbol}] Symbol set to: ${options.symbol}`);
    }
    if (options.ma200Period !== undefined) {
      this.ma200Data.period = options.ma200Period;
      logInfo(`[${this.name} - ${this.symbol}] MA200 period set to: ${options.ma200Period}`);
    }
  }

  startPlugin(klineWS) {
    
    connectDB()
      .then(() => {
        logInfo(`[${this.name} - ${this.symbol}] Database connection established.`);
      })
      .catch(err => {
        logError(`[${this.name} - ${this.symbol}] Database connection error: ${err.message}`);
      });

    logInfo(`[${this.name} - ${this.symbol}] startPlugin called, klineWS=${klineWS}`);
    if (klineWS) {
      this.klineWS = klineWS;
      try {
        this.symbol = new URL(klineWS).searchParams.get('symbol') || this.symbol;
        logInfo(`[${this.name} - ${this.symbol}] Extracted symbol from klineWS: ${this.symbol}`);
      } catch (err) {
        logWarn(`[${this.constructor.name}] Unable to parse symbol from klineWS: ${err.message}`);
      }
    }
    this.initializeWebSocket(this.klineWS);
  }
}

module.exports = AlphaBlendPlugin;
