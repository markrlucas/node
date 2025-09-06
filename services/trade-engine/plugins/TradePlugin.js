const WebSocketClient = require('../../../includes/WebSocketClient');
const createPluginLogger = require('./pluginsLogger');
const { logInfo, logWarn, logError } = createPluginLogger('TradePlugin') || require('../logger');
const WebSocket = require('ws');
const util = require('util'); // For detailed inspection if needed

class TradePlugin {
  constructor(options = {}) {
    this.name = 'TradePlugin';
    this.ws = null;
    this.klineWS = options.klineWS || null;
    this.symbol = options.symbol || null;
    this.duration = options.duration || '1m';
    this.limit = options.limit || 180;
    this.lastDecisionBroadcast = 0;

    // Initialize broadcast client for sending signals
    this.broadcastClient = new WebSocketClient(options.broadcastClientWS || 'ws://localhost:8083');
    this.broadcastClient.on('open', () => {
      logInfo('Connected to broadcast server on port 8083.');
    });
    this.broadcastClient.on('message', async (data) => {
        //logInfo(`[Trade Plugin] Raw signal: ${util.inspect(data, { depth: null, colors: true })}`);
        let signal;
       
     try {
          signal = data;
          if (signal.source !== 'TradePlugin') {
            //logWarn(`[Trade Plugin] Ignoring message from non-Graphs source: ${signal.source}`);
            return;
        }
        
          // Now submit your orders exactly as before
          if (signal.orders && Array.isArray(signal.orders)) {  ///DONT FORGET TO CHANGE THIS BACK TO ORDERS
            const promises = signal.orders.map(order =>
              this.submitOrder(
                order.clientOrderId,
                signal.symbol,
                signal.side,
                order.quantity,
                signal.price,
                signal.type
              )
            );
            const responses = await Promise.all(promises);
            logInfo(`[Trade Plugin] Orders submitted with responses: ${JSON.stringify(responses)}`);
          } else {
            try {
              const response = await this.submitOrder(
                signal.clientOrderIds ? signal.clientOrderIds[0] : null,
                signal.symbol,
                signal.side,
                signal.quantity,
                signal.price,
                signal.type
              );
              logInfo(`[Trade Plugin] Order submitted: ${JSON.stringify(response)}`);
            } catch (error) {
              logError('[Trade Plugin] Error submitting single order:', error);
            }
          }
        } catch (error) {
          logError('[Trade Plugin] Error processing message:', error);
        }
      });

    this.broadcastClient.on('error', (error) => logError('WebSocket error:', error));
    this.broadcastClient.on('close', () => logWarn('WebSocket closed.'));

    // Placeholder for trade data
    this.tradeData = {
      highs: [],
      lows: [],
      closes: [],
      volumes: [],
      length: 180,  // Length of the data window
      symbol: this.symbol,
    };
  }

  broadcastSignal(signalData) {
    if (!this.broadcastClient || this.broadcastClient.readyState !== WebSocket.OPEN) {
      logWarn(`[TradePlugin] Cannot broadcast signal, WebSocket not open.`);
      return;
    }

    const message = {
      type: 'signal',
      data: signalData,
      timestamp: Date.now()
    };

    try {
      this.broadcastClient.send(JSON.stringify(message));
      logInfo(`[TradePlugin] Signal broadcasted: ${JSON.stringify(message)}`);
    } catch (error) {
      logError(`[TradePlugin] Error broadcasting signal:`, error);
    }
  }

  submitOrder(clientOrderId, symbol, side, quantity, price, orderType) {
    if (!symbol || !side || !quantity) {
      return Promise.reject(new Error('Missing required parameters: symbol, side, quantity, price'));
    }
    const signal = {
      plugin: this.name,
      clientOrderId: clientOrderId || null,
      symbol: symbol,
      action: side,
      quantity: quantity,
      price: price,
      type: orderType || 'market', // Use orderType provided or default to 'market'
      reason: `TradePlugin ${side} signal received from trade dashboard`,
      timestamp: Date.now(),
    };

    logInfo(`[TradePlugin] Submitting order: ${JSON.stringify(signal)}`);

    return new Promise((resolve, reject) => {
      try {
        this.broadcastSignal(signal);
        resolve({ success: true, order: signal });
        logInfo(`[TradePlugin] Order submitted: ${JSON.stringify(signal)}`);
      } catch (error) {
        reject(error);
      }
    });
  }

  startPlugin(klineWS) {
    if (klineWS) {
      this.klineWS = klineWS;
      logInfo(`[TradePlugin] Starting plugin with klineWS: ${this.klineWS}`);
      try {
        this.symbol = new URL(klineWS).searchParams.get('symbol') || this.symbol;
        logInfo(`[TradePlugin] Extracted symbol from klineWS: ${this.symbol}`);
      } catch (err) {
        logWarn(`[TradePlugin] Unable to parse symbol from klineWS: ${err.message}`);
      }
    }
    //this.initializeWebSocket(this.klineWS);
  }
}

module.exports = TradePlugin;