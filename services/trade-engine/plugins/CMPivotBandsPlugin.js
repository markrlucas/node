const WebSocket = require('ws');
const createPluginLogger = require('./pluginsLogger');
const { logInfo, logWarn, logError } = createPluginLogger('CMPivotBands') || require('../logger');
const WebSocketClient = require('../../../includes/WebSocketClient');
const pm2events = require('../websockets/pm2events');

// Add a debug logging function
function logDebug(message) {
  if (CMPivotBandsPlugin.debug) {
    console.debug(`[DEBUG] ${message}`);
  }
}

class CMPivotBandsPlugin {
  constructor(options = {}) {
    this.name = 'CMPivotBandsPlugin';
    this.ws = null;
    this.klineWS = options.klineWS || null;
    this.symbol = options.symbol || 'BTCUSDT';
    this.duration = options.duration || '1m';
    this.limit = options.limit || 180;
    this.debug = options.debug || true; // Add debug flag

    this.broadcastClient = new WebSocketClient(options.broadcastClientWS || 'ws://localhost:8083');
    this.broadcastClient.on('open', () => logInfo(`[${this.name}] Connected to broadcast server on port 8083.`));
    this.broadcastClient.on('error', (error) => logError(`[${this.name}] Broadcast WebSocket error:`, error));
    this.broadcastClient.on('close', () => logWarn(`[${this.name}] Broadcast WebSocket closed.`));

    this.pivotBandsData = {
      candles: [],
      period: options.period || 7,
      emaLength: options.emaLength || 7
    };

    this.lastSignalAction = null;
    this.lastSignalPrice = null;
  }

  // --- Helper Function ---
// Calculates pivot values for an array of candles.
// For each candle, compute:
//   PP = (high + low + close) / 3
//   HP1 = PP + (PP - low)
//   LP1 = PP - (high - PP)
    calculatePivotValues(candles) {
      return candles.map(c => {
        const PP = (c.high + c.low + c.close) / 3;
        return {
          PP,
          HP1: PP + (PP - c.low),
          LP1: PP - (c.high - PP)
        };
      });
    }

  initializeWebSocket(klineWS) {
    if (klineWS) this.klineWS = klineWS;
    if (!this.klineWS) {
      logError(`[${this.name}] klineWS not provided. Cannot initialize WebSocket.`);
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    logInfo(`[${this.name}] Connecting to ${this.klineWS}...`);
    logDebug(`[${this.name}] WebSocket initialization parameters: ${JSON.stringify({ klineWS: this.klineWS })}`);
    this.ws = new WebSocket(this.klineWS);

    this.ws.on('message', (Kline) => {
      const klineStr = (typeof Kline === 'string') ? Kline : Kline.toString('utf8');
      logDebug(`[${this.name}] Received WebSocket message: ${klineStr}`);
      if (klineStr.includes('kline')) {
        const klineData = JSON.parse(klineStr);
        if (klineData.k.x === true) {
          this.processWebSocketMessage(klineData.k);
        }
      }
    });

    this.ws.on('close', () => {
      logWarn(`[${this.name}] Connection closed. Reconnecting in 5 seconds...`);
      setTimeout(() => this.initializeWebSocket(), 5000);
    });

    this.ws.on('error', (error) => logError(`[${this.name}] WebSocket error: ${error.message}`));
  }

  processWebSocketMessage(message) {
    try {
      const data = JSON.parse(message);
      logDebug(`[${this.name}] Parsed WebSocket message: ${JSON.stringify(data)}`);
      // Historical data handling
      if (data.type === 'historical' && Array.isArray(data.data)) {
        logInfo(`[${this.name}] Received ${data.data.length} historical candles.`);
        this.pivotBandsData.candles = data.data.map(k => ({
          open: parseFloat(k.k.o),
          high: parseFloat(k.k.h),
          low: parseFloat(k.k.l),
          close: parseFloat(k.k.c),
          volume: parseFloat(k.k.v),
          timestamp: k.k.t
        }));
        this.processHistoricalData();
      }
      // Live kline data handling
      else if (data.e === 'kline' && data.k) {
        const candle = {
          close: parseFloat(data.k.c),
          high: parseFloat(data.k.h),
          low: parseFloat(data.k.l),
          timestamp: data.k.t
        };
        this.processLiveCandle(candle);
      }
    } catch (error) {
      logError(`[${this.name}] Error parsing WebSocket message: ${error.message}`);
    }
  }

  processHistoricalData() {
    logInfo(`[${this.name}] Processing historical data...`);
    for (let i = 0; i < this.pivotBandsData.candles.length; i++) {
      this.processCandle(this.pivotBandsData.candles[i]);
    }
  }

  processLiveCandle({ close, high, low, timestamp }) {
    const candles = this.pivotBandsData.candles;
    const lastCandle = candles[candles.length - 1];
    if (!lastCandle || lastCandle.timestamp !== timestamp) {
      // New candle
      const newCandle = { close, high, low, timestamp };
      candles.push(newCandle);
      this.processCandle(newCandle);
    } else {
      // Update existing candle
      lastCandle.high = Math.max(lastCandle.high, high);
      lastCandle.low = Math.min(lastCandle.low, low);
      lastCandle.close = close;
      this.processCandle(lastCandle);
    }
  }

  processCandle(candle) {
    logInfo(`[${this.name}] Processing candle -> Close=${candle.close}, High=${candle.high}, Low=${candle.low}, TS=${candle.timestamp}`);
    logDebug(`[${this.name}] Current candles array: ${JSON.stringify(this.pivotBandsData.candles)}`);

    // Enforce a maximum number of candles equal to the configured period
    if (this.pivotBandsData.candles.length > this.pivotBandsData.period) {
      this.pivotBandsData.candles.shift();
      logDebug(`[${this.name}] Shifted candles array to maintain period limit.`);
    }

    // Only proceed if we have enough candles for pivot calculations
    if (this.pivotBandsData.candles.length >= this.pivotBandsData.period) {
      const decision = this.makeDecision(candle);
      if (decision) {
        logInfo(`[${this.name}] Decision: ${decision.action}, Price=${decision.price}, Reason=${decision.reason}`);
        logDebug(`[${this.name}] Decision details: ${JSON.stringify(decision)}`);
        this.broadcastSignal(decision);
      }
    } else {
      logInfo(`[${this.name}] Not enough candles yet. Need ${this.pivotBandsData.period}, have ${this.pivotBandsData.candles.length}.`);
    }
  }

  makeDecision(latestCandle) {
    try {
      const { candles, emaLength, period } = this.pivotBandsData;
      if (candles.length < period) return null;

      logDebug(`[${this.name}] Calculating decision with candles: ${JSON.stringify(candles)}`);

      // 1) Calculate pivot values from the current sliding window of candles
      const pivotValues = calculatePivotValues(candles);
      logDebug(`[${this.name}] Calculated pivot values: ${JSON.stringify(pivotValues)}`);

      // 2) Extract PP values from the pivot values
      const PPArray = pivotValues.map(p => p.PP);
      // 3) Compute the EMA of PP values over emaLength bars
      const emaSeries = EMA.calculate({ period: emaLength, values: PPArray });
      if (emaSeries.length === 0) return null;
      const PPEMA = emaSeries[emaSeries.length - 1];
      // 4) Compute average difference between HP1 and LP1 across the window
      const diffs = pivotValues.map(p => p.HP1 - p.LP1);
      const avgDiff = diffs.reduce((acc, d) => acc + d, 0) / diffs.length;
      // 5) Compute pivot bands: r1 and s1
      const r1 = PPEMA + avgDiff;
      const s1 = PPEMA - avgDiff;
      const price = latestCandle.close;

      let action = 'HOLD';
      let reason = 'Price within pivot bands';
      if (price > r1) {
        action = 'BUY';
        reason = `Price ${price} above R1 ${r1.toFixed(4)}`;
      } else if (price < s1) {
        action = 'SELL';
        reason = `Price ${price} below S1 ${s1.toFixed(4)}`;
      }

      return { action, price, reason };
    } catch (err) {
      logError(`[${this.name}] Error making decision: ${err.message}`);
      return null;
    }
  }

  updateParams(options = {}) {
    logInfo(`[${this.name}] Updating parameters: ${JSON.stringify(options)}`);
    logDebug(`[${this.name}] Current parameters before update: ${JSON.stringify({
      klineWS: this.klineWS,
      symbol: this.symbol,
      period: this.pivotBandsData.period,
      emaLength: this.pivotBandsData.emaLength,
      limit: this.limit
    })}`);

    if (options.klineWS) {
      const baseUrl = options.klineWS;
      const params = new URLSearchParams();
      if (options.symbol) params.append('symbol', options.symbol);
      if (options.duration) params.append('interval', options.duration);
      if (options.limit) params.append('limit', options.limit);
      this.klineWS = `${baseUrl}?${params.toString()}`;
      logInfo(`[${this.name}] klineWS updated to: ${this.klineWS}`);
    }
    if (options.symbol) this.symbol = options.symbol;
    if (options.period !== undefined) this.pivotBandsData.period = options.period;
    if (options.emaLength !== undefined) this.pivotBandsData.emaLength = options.emaLength;
    if (options.limit !== undefined) this.limit = options.limit;
    logInfo(`[${this.name}] Parameters updated: ${JSON.stringify(options)}`);
    logDebug(`[${this.name}] Updated parameters: ${JSON.stringify({
      klineWS: this.klineWS,
      symbol: this.symbol,
      period: this.pivotBandsData.period,
      emaLength: this.pivotBandsData.emaLength,
      limit: this.limit
    })}`);
  }

  startPlugin(klineWS) {
    if (klineWS) {
      this.klineWS = klineWS;
      logInfo(`[${this.name}] Starting plugin with klineWS: ${this.klineWS}`);
    }
    logDebug(`[${this.name}] Plugin start parameters: ${JSON.stringify({ klineWS: this.klineWS })}`);
    this.initializeWebSocket(this.klineWS);
  }

  stopPlugin() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      logInfo(`[${this.name}] Plugin stopped.`);
      logDebug(`[${this.name}] WebSocket connection closed.`);
    }
  }
}

module.exports = CMPivotBandsPlugin;
