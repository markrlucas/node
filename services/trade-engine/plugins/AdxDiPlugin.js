const WebSocket = require('ws');
const axios = require('axios');
const createPluginLogger = require('./pluginsLogger');
const { logInfo, logWarn, logError } = createPluginLogger('ADXDi') || require('../logger');
const WebSocketClient = require('../../../includes/WebSocketClient');
const pm2events = require('../websockets/pm2events');


class AdxDiPlugin  {
  constructor(options = {}) {
    this.name = 'AdxDiPlugin';
    this.ws = null; // WebSocket instance
    this.klineWS = options.klineWS || null  ;
    this.symbol = options.symbol || null;
    this.duration = options.duration || '1m';
    this.limit = options.limit || 14;
    this.lastDecisionBroadcast = 0;

    this.adxData = {}; // ADX data object

    this.broadcastClient = new WebSocketClient(options.broadcastClientWS || 'ws://localhost:8083');

    // NEW: Add decision interval and intermediate signal flag
    this.decisionInterval = options.decisionInterval || 60000; // default to 60 seconds
    this.intermediateSignal = options.intermediateSignal || false; // default disabled
    this.currentAggregatedCandle = null;
    
    this.broadcastClient.on('open', () => { logInfo('Connected to broadcast server on port 8083.'); });
    this.broadcastClient.on('error', (error) => logError('WebSocket error:', error));
    this.broadcastClient.on('close', () => logWarn('WebSocket closed.'));
    
    // ADX-specific data and defaults
    this.adxData = {
      highs: [],
      lows: [],
      closes: [],
      tr: [],
      dmPlus: [],
      dmMinus: [],
      dx: [],
      adx: [],
      dxArray: [],
      smoothedTR: null,
      smoothedDmPlus: null,
      smoothedDmMinus: null,
      length: options.length || 24,
      trendThreshold: options.trendThreshold || 25,
      smoothingLength: options.smoothingLength || 8,
    };

    
  }

   broadcastSignal(signalData) {
    const message = {
      type: 'signal',
      data: signalData,
      timestamp: Date.now()
    };
    this.broadcastClient.send(message);
  }

  initializeWebSocket(klineWS) {
    if (klineWS) this.klineWS = klineWS;
    //logInfo(`[Debug AdxDiPlugin] Initializing WebSocket with URL: ${this.klineWS}`);
    if (!this.klineWS) {
      logError('[AdxDiPlugin] klineWS not provided. Cannot initialize WebSocket.');
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      //logInfo('[Debug AdxDiPlugin] WebSocket already connected.');
      return;
    }
    //logInfo('[Debug AdxDiPlugin] Connecting to local WebSocket...');
    this.ws = new WebSocket(this.klineWS);
    //logInfo('[Debug AdxDiPlugin] WebSocket created.', this.ws);

    this.ws.on('message', (Kline) => {
      
      const klineStr = (typeof Kline === 'string') ? Kline : Kline.toString('utf8');
   //   console.log('[Debug AdxDiPlugin] - This is the klineStr', klineStr);
      if (klineStr.includes('kline')) {
        const klineData = JSON.parse(klineStr);
        if (klineData.k.x === true) {
    //      console.log('[Debug AdxDiPlugin] - This is the klineData', klineData.k);
          this.processNewPriceData(klineData.k);
        }
        return;
      }
    });
    this.ws.on('close', () => {
      logWarn('[AdxDiPlugin] Connection closed. Reconnecting in 5 seconds...');
      setTimeout(() => this.initializeWebSocket(), 5000);
    });
    this.ws.on('error', (error) => logError(`[AdxDiPlugin] WebSocket error: ${error.message}`));
  }

  /**
   * Stores new price data and calculates ADX and DI values.
   * @param {Object} priceData 
   */
  async processNewPriceData({ c: price, h: high, l: low, t: timestamp, v: volume }) {
    const parsedHigh = parseFloat(high).toFixed(2);
    const parsedLow = parseFloat(low).toFixed(2);
    const parsedPrice = parseFloat(price).toFixed(2);
    const parsedVolume = volume ? parseFloat(volume) : 0;

    this.adxData.highs.push(parsedHigh);
    this.adxData.lows.push(parsedLow);
    this.adxData.closes.push(parsedPrice);

    // Maintain a sliding window based on the defined length
    if (this.adxData.highs.length > this.adxData.length) {
      this.adxData.highs.shift();
      this.adxData.lows.shift();
      this.adxData.closes.shift();
    }

    const trendSignal = await this.calculateAdxTrend({ price, high, low, timestamp });
    //console.log('[AdxDiPlugin] Final singal from this plugin.', trendSignal);
    // Send trend condition to Broadcast Service
    this.broadcastSignal(trendSignal);
  }

  /**
   * Computes ADX, DI+, and DI-, then determines trend strength.
   * Implements a recursive smoothing approach similar to the Pine Script.
   */
  async calculateAdxTrend({ price, high, low, timestamp }) {
    try {
      // Ensure we have at least one previous candle for comparison
      if (this.adxData.highs.length < 2 || this.adxData.closes.length < 2) {
        //logInfo('[AdxDiPlugin] Not enough historical data for ADX calculation.');
        return {
          marketTrend: 'Unknown',
          adx: null,
          diPlus: null,
          diMinus: null,
          reason: 'Not enough data for ADX calculation',
          timestamp: timestamp
        };
      }

      // Get previous candle values (second last in the arrays)
      const prevHigh = this.adxData.highs[this.adxData.highs.length - 2];
      const prevLow = this.adxData.lows[this.adxData.lows.length - 2];
      const prevClose = this.adxData.closes[this.adxData.closes.length - 2];

      // Calculate True Range
      const trueRange = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );

      // Calculate directional movements
      let dmPlus = 0;
      let dmMinus = 0;
      if ((high - prevHigh) > (prevLow - low)) {
        dmPlus = Math.max(high - prevHigh, 0)
      }
      if ((prevLow - low) > (high - prevHigh)) {
        dmMinus = Math.max(prevLow - low, 0);
      }

      // Recursive smoothing (as in Pine Script)
      const len = this.adxData.smoothingLength;
      if (this.adxData.smoothedTR === null) {
        this.adxData.smoothedTR = trueRange;
        this.adxData.smoothedDmPlus = dmPlus;
        this.adxData.smoothedDmMinus = dmMinus;
      } else {
        this.adxData.smoothedTR = this.adxData.smoothedTR - (this.adxData.smoothedTR / len) + trueRange;
        this.adxData.smoothedDmPlus = this.adxData.smoothedDmPlus - (this.adxData.smoothedDmPlus / len) + dmPlus;
        this.adxData.smoothedDmMinus = this.adxData.smoothedDmMinus - (this.adxData.smoothedDmMinus / len) + dmMinus;
      }

      // Compute DI+ and DI-
      const diPlus = parseFloat(((this.adxData.smoothedDmPlus / this.adxData.smoothedTR) * 100).toFixed(2));
      const diMinus = parseFloat(((this.adxData.smoothedDmMinus / this.adxData.smoothedTR) * 100).toFixed(2));

            
      // Send DI+ and DI- values to PM2 events
      //logInfo(`[AdxDiPlugin] DI+ (${diPlus.toFixed(2)}) and DI- (${diMinus.toFixed(2)}) calculated.`);
      pm2events.send('signal', 'pluginSignal', { diPLus: diPlus, diMinus: diMinus });      

      // Compute DX for this candle
      const dx = (Math.abs(diPlus - diMinus) / (diPlus + diMinus)) * 100;

      // Update DX array for ADX calculation
      this.adxData.dxArray.push(dx);
      if (this.adxData.dxArray.length > len) {
        this.adxData.dxArray.shift();
      }

      // Calculate ADX as the SMA of the DX values once we have enough data.
      let adx = null;
      if (this.adxData.dxArray.length === len) {
        adx = parseFloat((this.adxData.dxArray.reduce((sum, val) => sum + val, 0) / len).toFixed(2));
      }

      // Determine market condition
      let marketTrend = 'Trending';
      let reason = adx !== null
        ? `ADX (${adx.toFixed(2)}) indicates a strong trend`
        : 'Not enough DX data to compute ADX';

      if (adx !== null && adx < this.adxData.trendThreshold) {
        marketTrend = 'Ranging';
        reason = `ADX (${adx.toFixed(2)}) suggests a weak trend, suitable for scalping`;
      }

      return {
        plugin: 'AdxDiPlugin',
        symbol: this.symbol,                
        marketTrend,
        adx,
        diPlus,
        diMinus,
        reason,
        timestamp: timestamp
      };
    } catch (error) {
      logError(`[AdxDiPlugin] Error calculating ADX: ${error.message}`);
      return {
        marketTrend: 'Unknown',
        adx: null,
        diPlus: null,
        diMinus: null,
        reason: 'Error calculating ADX',
        timestamp: Date.now()
      };
    }
  }

  updateParams(options = {}) {
    if (options.length !== undefined) {
      this.adxData.length = options.length;
    }
    
    if (options.trendThreshold !== undefined) {
      this.adxData.trendThreshold = options.trendThreshold;
    }
    
    if (options.smoothingLength !== undefined) {
      this.adxData.smoothingLength = options.smoothingLength;
    }
    
    // Construct klineWS URL using the WS option and query parameters.
    if (options.WS) {
      const baseUrl = options.WS;
      const params = new URLSearchParams();
      if (options.symbol) {
        params.append('symbol', options.symbol);
      }
      if (options.duration) {
        params.append('interval', options.duration);
      }
      if (options.limit) {
        params.append('limit', options.limit);
      }
      this.klineWS = `${baseUrl}?${params.toString()}`;
    } else if (options.klineWS) {
      this.klineWS = options.klineWS;
    }
    
    if (options.decisionInterval !== undefined) {
      this.decisionInterval = options.decisionInterval;
    }
    
    if (options.intermediateSignal !== undefined) {
      this.intermediateSignal = options.intermediateSignal;
    }
    
    // Update the symbol if provided
    if (options.symbol) {
      this.symbol = options.symbol;
    }
  }
  
  startPlugin(klineWS) {
    if (klineWS) {
      this.klineWS = klineWS;
      //logInfo(`[AdxDiPlugin] Starting plugin with klineWS: ${this.klineWS}`);
      try {
        this.symbol = new URL(klineWS).searchParams.get('symbol') || this.symbol;
        //logInfo(`[Debug AdxDiPlugin] Extracted symbol from klineWS: ${this.symbol}`);  

      } catch (err) {
        logWarn(`[${this.constructor.name}] Unable to parse symbol from klineWS: ${err.message}`);
      }
    }
    // Always initialize the WebSocket using the internal klineWS value.
    this.initializeWebSocket(this.klineWS);
  }
}

module.exports = AdxDiPlugin;
