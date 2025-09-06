const WebSocket = require('ws');
const createPluginLogger = require('./pluginsLogger');
const { logInfo, logWarn, logError } = createPluginLogger('LDKJWhalePlugin') || require('../logger');
const WebSocketClient = require('../../../includes/WebSocketClient');
const pm2events = require('../websockets/pm2events');
const util = require('util'); // For detailed inspection if needed


// --- Helper Functions ---
function lowest(arr, period) {
  if (arr.length === 0) return NaN;
  const slice = arr.slice(-period);
  return Math.min(...slice);
}

function highest(arr, period) {
  if (arr.length === 0) return NaN;
  const slice = arr.slice(-period);
  return Math.max(...slice);
}

function xrf(values, length) {
  if (values.length > length) {
    return values[values.length - 1 - length];
  }
  return NaN;
}

// --- Stateful Smoothing Classes ---
class XSA {
  constructor(len, wei) {
    this.len = len;
    this.wei = wei;
    this.values = [];
    this.sumf = 0;
    this.out = NaN;
  }
  update(x) {
    this.values.push(x);
    if (this.values.length === 1) {
      this.sumf = x;
      this.out = (this.values.length >= this.len) ? (this.sumf / this.len) : NaN;
    } else {
      const removed = (this.values.length > this.len) ? this.values[this.values.length - 1 - this.len] : 0;
      this.sumf = (isNaN(this.sumf) ? 0 : this.sumf) - removed + x;
      const ma = (this.values.length >= this.len) ? (this.sumf / this.len) : NaN;
      if (isNaN(this.out)) {
        this.out = ma;
      } else {
        this.out = (x * this.wei + this.out * (this.len - this.wei)) / this.len;
      }
    }
    return this.out;
  }
}

class EMA {
  constructor(period) {
    this.period = period;
    this.multiplier = 2 / (period + 1);
    this.ema = NaN;
  }
  update(value) {
    if (isNaN(this.ema)) {
      this.ema = value;
    } else {
      this.ema = (value - this.ema) * this.multiplier + this.ema;
    }
    return this.ema;
  }
}

// --- L2KDJ Plugin Implementation ---
class L2KDJPlugin {
  constructor(options = {}) {
    this.name = 'L2KDJPlugin';
		this.ws = null;
		this.klineWS = options.klineWS || null;
		this.symbol = options.symbol || null;
		this.duration = options.duration || '1m';
		this.limit = options.limit || 180;
    this.pumpdetection = 0; // Initialize pumpdetection counter
    this.pumpdetector = false; // Initialize pumpdetector flag
    this.whaledetection = 0; // Initialize whaledetection counter
    this.whaledetector = false; // Initialize pumpdetector flag
    this.dipDetected = false; // Initialize dip detection flag for whale pump logic
    this.adxData = {}; // ADX data object
    this.evaluationHistory = []; // For signal analysis

    // Whale Pump Monitoring State
    this.whalePumpMonitoring = {
      active: false, // Is the whale pump monitoring currently active?
      tickThreshold: 3, // How many ticks of deviation are allowed before abandoning the check.
      confirmationSteps: 2, // How many consecutive confirmation signals are needed to trigger a BUY.
      rangePercent: 0.25, // The percentage variance allowed for the targetProduct.
      targetProduct: 0, // The initial (J * whalePump) value we are monitoring.
      lowerBound: 0, // The lower boundary of the acceptable range for the targetProduct.
      upperBound: 0, // The upper boundary of the acceptable range for the targetProduct.
      tickCount: 0, // Counter for deviations from the expected range.
      crossedOver: false, // Flag to indicate if J has crossed above the initial whalePump value.
      postCrossoverConfirmation: 0, // Counter for confirmation steps after the crossover.
      lastCurrJ: 0, // The J value from the previous candle for trend comparison.
      initialWhalePump: 0 // The whalePump value when monitoring was initiated.
    };

    // Configuration inputs
    this.config = {
      BuyAlertLimit: options.BuyAlertLimit || -10,
      SellAlertLimit: options.SellAlertLimit || 110,
      n1: options.n1 || 18,
      m1: options.m1 || 4,
      m2: options.m2 || 4
    };

    // Data arrays for candles and computed series
    this.candles = [];
    this.highs = [];
    this.lows = [];
    this.closes = [];
    this.var3s = [];
    this.KHistory = [];
    this.DHistory = [];
    this.JHistory = [];

    // Stateful smoothing/EMA objects
    this.xsaAbs = new XSA(3, 1);
    this.xsaMax = new XSA(3, 1);
    this.emaVar3 = new EMA(3);
    this.emaVar7 = new EMA(3);
    this.xsaVar9 = new XSA(13, 8);
    this.xsaK = new XSA(4, 1);
    this.xsaD = new XSA(4, 1);
    
    this.clientOrderId = null; // Client order ID for trades

    this.broadcastClient = new WebSocketClient(options.broadcastClientWS || 'ws://localhost:8083');
  
    this.broadcastClient.on('open', () => { logInfo('Connected to broadcast server on port 8083.'); });
    this.broadcastClient.on('error', (error) => logError('WebSocket error:', error));
    this.broadcastClient.on('close', () => logWarn('WebSocket closed.'));
    
    // Listen for incoming signals from other plugins
    pm2events.on('signal', (message) => {
      
      if (message.type == 'pluginSignal') {
       // logInfo(util.inspect(message, { showHidden: true, depth: null, colors: true }));
      let signal = message.data;
      //logInfo('[L2KDJPlugin] Received pm2 pluginSignal:', signal);
      // Check if the signal is a Buffer and decode it
      if (typeof signal === 'string') {
          try {
              this.adxData = JSON.parse(signal);
          } catch (error) {
              logError('[L2KDJPlugin] Error parsing JSON:', error);
              return;
          }
      }
      //logInfo('[L2KDJPlugin] Received pm2 pluginSignal:', signal);
      }
    });}
    

  initializeWebSocket(klineWS) {
    if (klineWS) this.klineWS = klineWS;
    if (!this.klineWS) {
      logError('[L2KDJPlugin] klineWS not provided. Cannot initialize WebSocket.');
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    logInfo(`[L2KDJPlugin] Connecting to ${this.klineWS}...`);
    this.ws = new WebSocket(this.klineWS);
    logInfo('[Debug L2KDJPlugin] WebSocket created.', this.ws);

    this.ws.on('message', (Kline) => {
    
      const klineStr = (typeof Kline === 'string') ? Kline : Kline.toString('utf8');
      //logInfo('[L2KDJPlugin[Debug L2KDJPlugin] - This is the klineStr', klineStr);
      if (klineStr.includes('kline')) {
      const klineData = JSON.parse(klineStr);
      if (klineData.k.x === true) {
      //logInfo('[L2KDJPlugin[Debug L2KDJPlugin] - This is the klineData', klineData.k);
        this.processWebSocketMessage(klineData);
      }
      return;
      }
    });
    this.ws.on('close', () => {
      logWarn('[L2KDJPlugin] Connection closed. Reconnecting in 5 seconds...');
      setTimeout(() => this.initializeWebSocket(), 5000);
    });
    this.ws.on('error', (error) => logError(`[L2KDJPlugin] WebSocket error: ${error.message}`));
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
      // Process only 1m candles
      if (kline.k && kline.k.i === "1m") {
        this.processNewPriceData(kline.k);
      }
    } catch (error) {
      logError(`[L2KDJPlugin] Error processing WebSocket message: ${error.message}`);
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
    this.highs.push(newCandle.high);
    this.lows.push(newCandle.low);
    this.closes.push(newCandle.close);

    // Maintain a fixed size for the history arrays to prevent memory leaks
    const maxHistory = this.config.n1 + 100; // A bit larger than the max lookback period
    if (this.candles.length > maxHistory) {
      this.candles.shift();
      this.highs.shift();
      this.lows.shift();
      this.closes.shift();
      this.var3s.shift();
      this.KHistory.shift();
      this.DHistory.shift();
      this.JHistory.shift();
    }

    const decision = this.makeDecision(newCandle);

    // --- Evaluation History & Broadcasting ---
    const evaluationEntry = {
      Timestamp: new Date(decision.timestamp).toISOString(),
      Action: decision.action,
      Reason: decision.reason,
      Close: decision.price,
      J: decision.J,
      K: decision.K,
      D: decision.D,
      WhalePump: decision.whalePump,
      'Monitor Active': this.whalePumpMonitoring.active,
      'Monitor Ticks': this.whalePumpMonitoring.tickCount,
      'Monitor Crossed': this.whalePumpMonitoring.crossedOver,
      'Monitor Target': this.whalePumpMonitoring.targetProduct,
      'Monitor Lower': this.whalePumpMonitoring.lowerBound,
      'Monitor Upper': this.whalePumpMonitoring.upperBound,
      'Monitor Post-Cross': this.whalePumpMonitoring.postCrossoverConfirmation,
      'Monitor Initial WP': this.whalePumpMonitoring.initialWhalePump
    };
    this.evaluationHistory.push(evaluationEntry);
    if (this.evaluationHistory.length > 50) { // Keep history to a reasonable size
      this.evaluationHistory.shift();
    }

    // Broadcast every decision for real-time data, but only log major signals to console
    this.broadcastSignal(decision);

    if (decision.action === 'BUY' || decision.action === 'SELL') {
      console.clear();
      console.log(`\n* ${this.name} Signal Triggered: ${decision.action} for ${this.symbol} *`);
      console.table(this.evaluationHistory);
      console.log('*'.repeat(80));
    }
  }

  makeDecision(candle) {
    const { close, high, low, timestamp } = candle;
    const open = candle.open; // Explicitly get open price

    // --- Whale Pump Preparation Calculations ---
    // These calculations are derived from a PineScript indicator and aim to quantify buying/selling pressure.
    const var1 = xrf(this.lows, 1); // Previous low
    const diff = Math.abs(low - var1);
    const diffMax = Math.max(low - var1, 0);
    const xsaAbsVal = this.xsaAbs.update(diff);
    const xsaMaxVal = this.xsaMax.update(diffMax);
    const var2 = (xsaMaxVal !== 0 ? (xsaAbsVal / xsaMaxVal) : 0) * 100;
    const var3 = this.emaVar3.update(var2 * 10);
    this.var3s.push(var3);
    const var4 = lowest(this.lows, 38);
    const var5 = highest(this.var3s, 38);
    const lowest_1 = lowest(this.lows, 90);
    const var6 = lowest_1 ? 1 : 0;
    const tempVar7 = (low <= var4 ? ((var3 + var5 * 2) / 2) : 0);
    const var7Raw = this.emaVar7.update(tempVar7);
    const var7 = (var7Raw / 618) * var6; // This value represents the "whale pump" pressure.
    const low21 = lowest(this.lows, 21);
    const high21 = highest(this.highs, 21);
    const var8 = ((close - low21) / (high21 - low21)) * 100;
    const var9 = this.xsaVar9.update(var8);

    // Whale pump value
    const whalePump = var7;

    // Maintain a bucket that tracks the maximum whalePump value and bleeds off over time.
    // This helps in identifying sustained pressure vs. a short-lived spike.
    if (this.whalePumpBucket === undefined) {
      this.whalePumpBucket = whalePump;
      this.whalePumpFillSpeed = 0;
    }
    const previousBucket = this.whalePumpBucket;
    if (whalePump > this.whalePumpBucket) {
      this.whalePumpBucket = whalePump;
      this.whalePumpFillSpeed = whalePump - previousBucket;
    } else {
      const bleedRate = this.config.holeBleedRate !== undefined ? this.config.holeBleedRate : 0.05;
      this.whalePumpBucket = Math.max(whalePump, this.whalePumpBucket - bleedRate);
      this.whalePumpFillSpeed = 0;
    }
    const whaleBleed = this.whalePumpBucket;

    // --- KDJ Calculations ---
    const n1 = this.config.n1;
    const lowest_n1 = lowest(this.lows, n1);
    const highest_n1 = highest(this.highs, n1);
    const rsv = ((close - lowest_n1) / (highest_n1 - lowest_n1)) * 100;
    const k_val = this.xsaK.update(rsv);
    const d_val = this.xsaD.update(k_val);
    const j_val = 3 * k_val - 2 * d_val;

    // Store history for crossovers
    this.KHistory.push(k_val);
    this.DHistory.push(d_val);
    this.JHistory.push(j_val);

    // Broadcast intermediate signal
    // This is now handled in processNewPriceData to ensure all signals are broadcast
    
    // logInfo(`[L2KDJPlugin] Broadcasting signal for ${this.symbol} at ${new Date(timestamp).toISOString()}`);
    
    // this.broadcastSignal({
    //   plugin: this.name,
    //   symbol: this.symbol,
    //   action: 'interHOLD',
    //   K: k_val,
    //   D: d_val,
    //   J: j_val,
    //   whalePump: whalePump,
    //   whaleBleed: whaleBleed,
    //   timestamp: timestamp
    // });

    // --- Signal and Alert Generation ---
    const lenHist = this.JHistory.length;
    let bgColor = null;
    let action = null;
    let reason = 'No signal';

    if (lenHist >= 2) {
      const prevJ = this.JHistory[lenHist - 2];
      const currJ = this.JHistory[lenHist - 1];
      const prevK = this.KHistory[lenHist - 2];
      const currK = this.KHistory[lenHist - 1];

      // Pump detection: A simple momentum check for extreme upward movement.
      if (prevJ >= prevK && currJ > currK && currJ > 110) {
        this.pumpdetection++;
        if (this.pumpdetection >= 5) {
          this.pumpdetector = true;
        }
      } else {
        // Reset if conditions are not met to avoid stale pump detection
        this.pumpdetection = 0;
      }

      // Trigger SELL if pump detection is active and J-line falls below a threshold.
      if (this.pumpdetector === true && currJ < 105) {
        bgColor = 'black';
        action = 'SELL';
        reason = 'Pump detector triggered SELL';
        if (!this.clientOrderId) { logError(`[${this.name} - ${this.symbol}] No clientOrderId found for SELL action. No SELL.`); }
        this.pumpdetector = false;
        this.pumpdetection = 0;
      }

      // --- Whale Pump Monitoring Logic ---
      // This is the core logic for detecting a potential dip-buying opportunity caused by a "whale pump".
      if (whalePump > 5) {
        // If monitoring is already active, continue checking the state.
        if (this.whalePumpMonitoring.active) {
          const monitor = this.whalePumpMonitoring;
          const currentProduct = currJ * monitor.initialWhalePump; // Product of J and the initial pump value.

          // Stage 1: Before J crosses over the initial whale pump value.
          if (!monitor.crossedOver) {
            // Check if J is still below the initial pump value.
            if (monitor.initialWhalePump > currJ) {
              // If the product deviates too much, it might be a false signal. Increment tick counter.
              if (currentProduct < monitor.lowerBound || currentProduct > monitor.upperBound) {
                monitor.tickCount++;
                logInfo('[L2KDJPlugin[Tick] Out of range before crossover. Tick count:', monitor.tickCount, {
                  currJ,
                  whalePump: monitor.initialWhalePump,
                  currentProduct,
                  lowerBound: monitor.lowerBound,
                  upperBound: monitor.upperBound
                });
              }
            } else {
              // J has crossed over the initial pump value. Move to the next stage.
              monitor.crossedOver = true;
              logInfo('[L2KDJPlugin[Cross Detected] currJ has crossed over whalePump. Monitoring continuation...');
            }
          } else { // Stage 2: After J has crossed over. Now we look for confirmation.
            // Confirmation logic: require J to be rising AND the candle to be bullish (price moving up).
            if (currJ > monitor.lastCurrJ && close > open && monitor.initialWhalePump < currJ) {
              monitor.postCrossoverConfirmation++;
              logInfo('[L2KDJPlugin[Post-Cross Confirmation] Confirmation tick received:', {
                currJ,
                whalePump: monitor.initialWhalePump,
                postCrossoverConfirmation: monitor.postCrossoverConfirmation
              });
            } else {
              // Reset if the trend reverses or stalls, as it invalidates the confirmation sequence.
              monitor.postCrossoverConfirmation = 0; 
            }
          }

          // Always update the last J value for the next iteration's comparison.
          monitor.lastCurrJ = currJ;

          // --- Resolution Logic: Decide whether to BUY or abandon monitoring ---
          if (monitor.postCrossoverConfirmation >= monitor.confirmationSteps) {
            logInfo('[L2KDJPlugin[WhalePumper Check] TRUE PUMP DETECTED]', { currJ, whalePump });
            bgColor = 'green';
            action = 'BUY';
            reason = 'Whale pump confirmed BUY';
            this.clientOrderId = null; // Reset clientOrderId for new trade
            this.clientOrderId = this.name.replace(/[^A-Z]/g, '') + Date.now().toString(16) + '_' + Math.floor(Math.random() * 9999 + 1).toString(16);
            
            this.dipDetected = false; // Reset flag
            this.whalePumpMonitoring.active = false; // Reset monitoring state
          } else if (monitor.tickCount >= monitor.tickThreshold) {
            logInfo('[L2KDJPlugin[Premature Exit] Tick threshold met before true crossover.');
            this.whalePumpMonitoring.active = false; // Reset monitoring state
          }
        }

        // This condition is for monitoring, not a trigger itself.
        if (currJ > 0 && Math.abs(whalePump - currJ) > 3) {
          
        // --- INITIATION: Start monitoring if conditions suggest a potential whale pump ---
        } else if (currJ < 0 && whalePump > 1 && !this.whalePumpMonitoring.active) {
          logInfo('[L2KDJPlugin[WhalePumper Check] INITIATED: Significant whale pump activity detected.', { whalePump, currJ });
          // Only start a new detection if one isn't already active
          this.dipDetected = true;
          logInfo('[L2KDJPlugin[WhalePumper Check] DIP DETECTED: currJ is negative while whalePump is still above 1. Starting to monitor.', { whalePump, currJ });
          
          // Initialize monitoring state
          const monitor = this.whalePumpMonitoring;
          monitor.active = true;
          monitor.targetProduct = currJ * whalePump;
          const variance = Math.abs(monitor.targetProduct * monitor.rangePercent);
          monitor.lowerBound = monitor.targetProduct - variance;
          monitor.upperBound = monitor.targetProduct + variance;
          monitor.tickCount = 0;
          monitor.crossedOver = false;
          monitor.postCrossoverConfirmation = 0;
          monitor.lastCurrJ = currJ;
          monitor.initialWhalePump = whalePump; // Store the pump value at the start of monitoring.
        }
      }
    }

   const signal = {
      plugin: this.name,
      symbol: this.symbol,
      action: action || 'interHOLD', // Default to interHOLD
      side: action,
      clientOrderId: this.clientOrderId || null, // Use the same clientOrderId as BUY
      price: close,
      K: k_val,
      D: d_val,
      J: j_val,
      whalePump: whalePump,
      whaleBleed: whaleBleed,
      timestamp: timestamp,
      reason: reason
    };

    return signal;
    // This signal will be broadcasted in processNewPriceData
  }  // End of makeDecision method

  updateParams(options = {}) {
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
  
    if (options.BuyAlertLimit !== undefined) {
      this.config.BuyAlertLimit = options.BuyAlertLimit;
    }
    if (options.SellAlertLimit !== undefined) {
      this.config.SellAlertLimit = options.SellAlertLimit;
    }
    if (options.n1 !== undefined) {
      this.config.n1 = options.n1;
    }
    if (options.m1 !== undefined) {
      this.config.m1 = options.m1;
    }
    if (options.m2 !== undefined) {
      this.config.m2 = options.m2;
    }
    if (options.klineWS) {
      this.klineWS = options.klineWS;
    }
    if (options.symbol) {
      this.symbol = options.symbol;
    }
  }

  startPlugin(klineWS) {
    if (klineWS) {
      this.klineWS = klineWS;
      try {
        this.symbol = new URL(klineWS).searchParams.get('symbol') || this.symbol;
      } catch (err) {
        logWarn(`[L2KDJPlugin] Unable to parse symbol from klineWS: ${err.message}`);
      }
    }
    this.initializeWebSocket(this.klineWS);
  }
}

module.exports = L2KDJPlugin;
