const WebSocket = require('ws');
const WebSocketClient = require('../../../includes/WebSocketClient');
const { logInfo, logWarn, logError } = require('../logger');

class MA200Plugin {
  constructor(options = {}) {
    this.name = 'MA200Plugin';
    this.ws = null;
    this.klineWS = options.klineWS || null;
    this.symbol = options.symbol || null;
    this.duration = options.duration || '1m';
    // limit can be used for initial data retrieval if necessary
    this.limit = options.limit || 200;
    this.broadcastClient = new WebSocketClient(options.broadcastClientWS || 'ws://localhost:8083');
    
    this.broadcastClient.on('open', () => { 
      logInfo('[MA200Plugin] Connected to broadcast server on port 8083.');
    });
    this.broadcastClient.on('error', (error) => logError('[MA200Plugin] Broadcast WebSocket error:', error));
    this.broadcastClient.on('close', () => logWarn('[MA200Plugin] Broadcast WebSocket closed.'));
    
    // Data for moving average calculation
    this.maData = {
      closes: [],
      period: options.maPeriod || 200
    };
    
    // For tracking previous computed values (for crossover detection)
    this.lastClose = null;
    this.lastSma = null;
    
    // Signal tracking variables
    this.lastSignalAction = null;
    this.lastSignalTimestamp = null;
    this.lastSignalPrice = null;
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
    if (!this.klineWS) {
      logError('[MA200Plugin] klineWS not provided. Cannot initialize WebSocket.');
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    logInfo(`[MA200Plugin] Connecting to WebSocket at: ${this.klineWS}...`);
    this.ws = new WebSocket(this.klineWS);
    
    this.ws.on('open', () => {
      logInfo('[MA200Plugin] WebSocket connected.');
      // Optionally send an init message (adjust as needed)
      // Example: this.ws.send(JSON.stringify({ type: 'init', symbol: this.symbol, duration: this.duration }));
    });
    this.ws.on('message', (message) => this.processWebSocketMessage(message));
    this.ws.on('close', () => {
      logWarn('[MA200Plugin] WebSocket closed. Reconnecting in 5 seconds...');
      setTimeout(() => this.initializeWebSocket(this.klineWS), 5000);
    });
    this.ws.on('error', (error) => logError(`[MA200Plugin] WebSocket error: ${error.message}`));
  }
  
  processWebSocketMessage(message) {
    try {
      const msgStr = typeof message === 'string' ? message : message.toString('utf8');
      const data = JSON.parse(msgStr);
      // Assuming data has a property "k" with kline info and that it represents a completed candle.
      if (data.k && data.k.x === true) { 
        // data.k.x === true indicates a finalized candle (depends on your data source)
        this.processNewPriceData(data.k, false);
      }
    } catch (error) {
      logError(`[MA200Plugin] Error processing WebSocket message: ${error.message}`);
    }
  }
  
  async processNewPriceData({ c: price, t: timestamp }, isHistorical = false) {
    // Convert price to a number and update the MA data.
    const parsedPrice = parseFloat(price);
    this.maData.closes.push(parsedPrice);
    
    // Maintain a sliding window of the required period.
    if (this.maData.closes.length > this.maData.period) {
      this.maData.closes.shift();
    }
    
    // Only make a decision if we have enough data.
    if (this.maData.closes.length >= this.maData.period) {
      const decision = await this.makeDecision(parsedPrice, timestamp);
      decision.price = parsedPrice.toFixed(3);
      decision.source = isHistorical ? "Historical" : "Live";
      logInfo(`[MA200Plugin] Decision: ${decision.action} | Price: ${decision.price} | SMA: ${decision.sma}`);
      this.broadcastSignal(decision);
      return decision;
    } else {
      logInfo(`[MA200Plugin] Not enough data for MA calculation. Current count: ${this.maData.closes.length}`);
      return {
        plugin: this.name,
        action: 'HOLD',
        price: parsedPrice.toFixed(3),
        reason: 'Insufficient data',
        timestamp: timestamp
      };
    }
  }
  
  async makeDecision(currentPrice, timestamp) {
    // Calculate the Simple Moving Average (SMA) for the current period.
    const sum = this.maData.closes.reduce((acc, price) => acc + price, 0);
    const sma = sum / this.maData.period;
    
    // Initialize decision as HOLD.
    let action = 'HOLD';
    let reason = `Price ${currentPrice.toFixed(3)} is within SMA ${sma.toFixed(3)}`;
    
    // Use previous price and SMA for detecting crossover.
    if (this.lastClose !== null && this.lastSma !== null) {
      // Cross upward: lastClose was below lastSma and currentPrice is above current sma.
      if (this.lastClose < this.lastSma && currentPrice >= sma) {
        action = 'BUY';
        reason = `Price crossed above SMA (from ${this.lastClose.toFixed(3)} < ${this.lastSma.toFixed(3)} to ${currentPrice.toFixed(3)} >= ${sma.toFixed(3)})`;
      }
      // Cross downward: lastClose was above lastSma and currentPrice is below current sma.
      else if (this.lastClose > this.lastSma && currentPrice <= sma) {
        action = 'SELL';
        reason = `Price crossed below SMA (from ${this.lastClose.toFixed(3)} > ${this.lastSma.toFixed(3)} to ${currentPrice.toFixed(3)} <= ${sma.toFixed(3)})`;
      }
    } else {
      reason = `Insufficient previous data for crossover detection; current SMA is ${sma.toFixed(3)}`;
    }
    
    // Update stored previous values for the next iteration.
    this.lastClose = currentPrice;
    this.lastSma = sma;
    
    // Update last signal tracking if action is BUY or SELL.
    if (action === 'BUY' || action === 'SELL') {
      this.lastSignalAction = action;
      this.lastSignalTimestamp = timestamp;
      this.lastSignalPrice = currentPrice.toFixed(3);
    }
    
    return {
      plugin: this.name,
      symbol: this.symbol,
      action,
      price: currentPrice.toFixed(3),
      sma: sma.toFixed(3),
      reason,
      timestamp: timestamp,
      config: {
        period: this.maData.period
      }
    };
  }
  
  updateParams(options = {}) {
    // If options.WS is provided, build the URL.
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
    
    if (options.symbol) {
      this.symbol = options.symbol;
    }
    
    if (options.maPeriod !== undefined) {
      this.maData.period = options.maPeriod;
    }
  }
  
  startPlugin(klineWS) {
    if (klineWS) {
      this.klineWS = klineWS;
      logInfo(`[MA200Plugin] Starting plugin with klineWS: ${this.klineWS}`);
      try {
        this.symbol = new URL(klineWS).searchParams.get('symbol') || this.symbol;
        logInfo(`[MA200Plugin] Extracted symbol from klineWS: ${this.symbol}`);
      } catch (err) {
        logWarn(`[MA200Plugin] Unable to parse symbol from klineWS: ${err.message}`);
      }
    }
    this.initializeWebSocket(this.klineWS);
  }
}

module.exports = MA200Plugin;
