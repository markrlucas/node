const WebSocket = require('ws');
const createPluginLogger = require('./pluginsLogger');
const { logInfo, logWarn, logError } = createPluginLogger('GoldenCrossPlugin') || require('../logger');
const WebSocketClient = require('../../../includes/WebSocketClient');
const pm2events = require('../websockets/pm2events');
const util = require('util'); // For detailed inspection if needed

// --- Helper Functions ---
function SMA(values, period) {
  if (values.length < period) return NaN;
  const slice = values.slice(-period);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / period;
}

// --- Golden Ratio Sell Plugin Implementation ---
class GoldenCrossPlugin {
  constructor(options = {}) {
    this.name = 'GoldenCrossPlugin';
    this.ws = null;
    this.klineWS = options.klineWS || null;
    this.symbol = options.symbol || null;
    this.duration = options.duration || '1m';
    this.limit = options.limit || 500;

    // Configurable thresholds (Bitcoin example defaults)
    this.config = {
      shortMAPeriod: options.shortMAPeriod || 50,       // White line
      longMAPeriod: options.longMAPeriod || 350,       // Green line
      redLine: options.redLine || 190558.96,           // Red line
      confirmationCandles: options.confirmationCandles || 3
    };

    // Data arrays
    this.candles = [];
    this.closes = [];

    // State
    this.crossDetected = false;
    this.confirmAboveRed = 0;
    this.clientOrderId = null;
    this.evaluationHistory = [];

    this.broadcastClient = new WebSocketClient(options.broadcastClientWS || 'ws://localhost:8083');

    this.broadcastClient.on('open', () => { logInfo('Connected to broadcast server on port 8083.'); });
    this.broadcastClient.on('error', (error) => logError('WebSocket error:', error));
    this.broadcastClient.on('close', () => logWarn('WebSocket closed.'));

    // Listen for incoming pm2 plugin signals (not used here, but kept for template parity)
    pm2events.on('signal', (message) => {
      if (message.type == 'pluginSignal') {
        let signal = message.data;
        if (typeof signal === 'string') {
          try {
            JSON.parse(signal);
          } catch (error) {
            logError('[GoldenCrossPlugin] Error parsing JSON:', error);
            return;
          }
        }
      }
    });
  }

  initializeWebSocket(klineWS) {
    if (klineWS) this.klineWS = klineWS;
    if (!this.klineWS) {
      logError('[GoldenCrossPlugin] klineWS not provided. Cannot initialize WebSocket.');
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    logInfo(`[GoldenCrossPlugin] Connecting to ${this.klineWS}...`);
    this.ws = new WebSocket(this.klineWS);

    this.ws.on('message', (Kline) => {
      const klineStr = (typeof Kline === 'string') ? Kline : Kline.toString('utf8');
      if (klineStr.includes('kline')) {
        const klineData = JSON.parse(klineStr);
        if (klineData.k.x === true) {
          this.processWebSocketMessage(klineData);
        }
        return;
      }
    });

    this.ws.on('close', () => {
      logWarn('[GoldenCrossPlugin] Connection closed. Reconnecting in 5 seconds...');
      setTimeout(() => this.initializeWebSocket(), 5000);
    });
    this.ws.on('error', (error) => logError(`[GoldenCrossPlugin] WebSocket error: ${error.message}`));
  }

  broadcastSignal(signalData) {
    const message = {
      type: 'signal',
      data: signalData,
      timestamp: Date.now()
    };
    this.broadcastClient.send(message);
  }

  processWebSocketMessage(kline) {
    try {
      if (kline.k && kline.k.i === this.duration) {
        this.processNewPriceData(kline.k);
      }
    } catch (error) {
      logError(`[GoldenCrossPlugin] Error processing WebSocket message: ${error.message}`);
    }
  }

  processNewPriceData(klineData) {
    const newCandle = {
      open: parseFloat(klineData.o),
      high: parseFloat(klineData.h),
      low: parseFloat(klineData.l),
      close: parseFloat(klineData.c),
      volume: parseFloat(klineData.v),
      timestamp: klineData.t
    };

    this.candles.push(newCandle);
    this.closes.push(newCandle.close);

    const maxHistory = this.config.longMAPeriod + 100;
    if (this.candles.length > maxHistory) {
      this.candles.shift();
      this.closes.shift();
    }

    const decision = this.makeDecision(newCandle);

    const evaluationEntry = {
      Timestamp: new Date(decision.timestamp).toISOString(),
      Action: decision.action,
      Reason: decision.reason,
      Close: decision.price,
      shortMA: decision.shortMA,
      longMA: decision.longMA,
      redLine: this.config.redLine,
      confirmCount: this.confirmAboveRed
    };
    this.evaluationHistory.push(evaluationEntry);
    if (this.evaluationHistory.length > 50) {
      this.evaluationHistory.shift();
    }

    this.broadcastSignal(decision);

    if (decision.action === 'SELL') {
      console.clear();
      console.log(`\n* ${this.name} Signal Triggered: ${decision.action} for ${this.symbol} *`);
      console.table(this.evaluationHistory);
      console.log('*'.repeat(80));
    }
  }

  makeDecision(candle) {
    const { close, timestamp } = candle;
    const shortMA = SMA(this.closes, this.config.shortMAPeriod);
    const longMA = SMA(this.closes, this.config.longMAPeriod);

    let action = 'interHOLD';
    let side = null;
    let reason = 'No signal';

    // Detect crossover (white crossing above green)
    if (!isNaN(shortMA) && !isNaN(longMA)) {
      if (shortMA > longMA && !this.crossDetected) {
        this.crossDetected = true;
        this.confirmAboveRed = 0;
        reason = 'Cross detected, waiting for confirmation';
      }

      if (this.crossDetected) {
        if (close > this.config.redLine) {
          this.confirmAboveRed++;
          if (this.confirmAboveRed >= this.config.confirmationCandles) {
            action = 'SELL';
            side = 'SELL';
            reason = `ShortMA > LongMA and price above redLine for ${this.confirmAboveRed} candles`;
            this.crossDetected = false; // reset after sell
            this.confirmAboveRed = 0;
            this.clientOrderId = this.name.replace(/[^A-Z]/g, '') + Date.now().toString(16);
          }
        } else {
          this.confirmAboveRed = 0;
          reason = 'Price not above redLine';
        }
      }
    }

    return {
      plugin: this.name,
      symbol: this.symbol,
      action,
      side,
      clientOrderId: action === 'SELL' ? this.clientOrderId : null,
      price: close,
      shortMA,
      longMA,
      redLine: this.config.redLine,
      confirmAboveRed: this.confirmAboveRed,
      timestamp,
      reason
    };
  }

  updateParams(options = {}) {
    if (options.WS) {
      const baseUrl = options.WS;
      const params = new URLSearchParams();
      if (options.symbol) params.append('symbol', options.symbol);
      if (options.duration) params.append('interval', options.duration);
      if (options.limit) params.append('limit', options.limit);
      this.klineWS = `${baseUrl}?${params.toString()}`;
    } else if (options.klineWS) {
      this.klineWS = options.klineWS;
    }

    if (options.shortMAPeriod !== undefined) this.config.shortMAPeriod = options.shortMAPeriod;
    if (options.longMAPeriod !== undefined) this.config.longMAPeriod = options.longMAPeriod;
    if (options.redLine !== undefined) this.config.redLine = options.redLine;
    if (options.confirmationCandles !== undefined) this.config.confirmationCandles = options.confirmationCandles;
    if (options.symbol) this.symbol = options.symbol;
  }

  startPlugin(klineWS) {
    if (klineWS) {
      this.klineWS = klineWS;
      try {
        this.symbol = new URL(klineWS).searchParams.get('symbol') || this.symbol;
      } catch (err) {
        logWarn(`[GoldenCrossPlugin] Unable to parse symbol from klineWS: ${err.message}`);
      }
    }
    this.initializeWebSocket(this.klineWS);
  }
}

module.exports = GoldenCrossPlugin;
