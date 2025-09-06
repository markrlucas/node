// plugins/PluginManager.js
const InitPlugins = require('./initPlugins');
const createPluginLogger = require('./pluginsLogger');
// Initialize logger for pluginManager
const { logInfo, logWarn, logError } = createPluginLogger('pluginManager') || require('../logger');

class PluginManager {
  constructor(initialConfig = {}) {
    // 1) extract the list of enabled plugin names
    this.enabledPlugins = initialConfig.enabledPlugins || Object.keys(initialConfig);

    // 2) build + hold onto your InitPlugins instance
    this.init = new InitPlugins(initialConfig);

    // 3) for each plugin in pluginsConfig, start its instance(s) if enabled
    for (const name of Object.keys(this.init.pluginsConfig)) {
      if (!this.enabledPlugins.includes(name)) {
        logInfo(`→ ${name} is disabled.`);
        continue;
      }

      const pluginOrArray = this.init[name];
      if (Array.isArray(pluginOrArray)) {
        // multiple instances: pluginOrArray = [ instance0, instance1, … ]
        pluginOrArray.forEach((instance, index) => {
          try {
            // apply initial params (InitPlugins already constructed them, but in case updateParams needs to run)
            const pluginOpts = initialConfig[name][index] || {};
            if (typeof instance.updateParams === 'function') {
              instance.updateParams(pluginOpts);
            }
            // start if available
            if (typeof instance.startPlugin === 'function') {
              instance.startPlugin();
              logInfo(`→ ${name}[${index}] started successfully.`);
            }
          } catch (error) {
            logError(`→ ${name}[${index}] failed to start: ${error.message}`);
          }
        });
      } else {
        // single instance
        try {
          const instance = pluginOrArray;
          const pluginOpts = initialConfig[name] || {};
          if (instance && typeof instance.updateParams === 'function') {
            instance.updateParams(pluginOpts);
          }
          if (instance && typeof instance.startPlugin === 'function') {
            instance.startPlugin();
            logInfo(`→ ${name} started successfully.`);
          }
        } catch (error) {
          logError(`→ ${name} failed to start: ${error.message}`);
        }
      }
    }
  }

  /**
   * Re-apply new options to one or more plugins at runtime.
   * @param {Object} newOpts  shape is { ProfitLossPlugin: {...}, AlphaBlendPlugin: [{...}, {...}], … }
   */
  reconfigure(newOpts) {
    // 1) delegate into InitPlugins.updateParams()
    this.init.updateParams(newOpts);

    // 2) for each key in newOpts, reconnect its WebSockets (if they exist)
    for (const name of Object.keys(newOpts)) {
      // if plugin is disabled, skip
      if (!this.enabledPlugins.includes(name)) {
        logWarn(`Reconfigure: ${name} is not enabled.`);
        continue;
      }

      const pluginOrArray = this.init[name];
      const rawOpts       = newOpts[name];

      if (Array.isArray(pluginOrArray)) {
        // array of instances → rawOpts should also be an array
        pluginOrArray.forEach((instance, idx) => {
          const optsForThisIndex = Array.isArray(rawOpts) ? rawOpts[idx] || {} : {};
          this._maybeReconnectInstance(name, instance, optsForThisIndex, idx);
        });
      } else {
        // single instance
        this._maybeReconnectInstance(name, pluginOrArray, rawOpts, null);
      }
    }
  }

  /**
   * If the plugin instance has WebSocket URLs that changed, close + re-open
   * @param {string} name         plugin name (e.g. "ProfitLossPlugin")
   * @param {Object} instance     the plugin instance
   * @param {Object} opts         the new options passed in for this instance
   * @param {number|null} idx     index if part of array, else null
   */
  _maybeReconnectInstance(name, instance, opts = {}, idx = null) {
    const label = idx === null ? name : `${name}[${idx}]`;

    // 1) klineWS or WS
    if ((opts.WS || opts.klineWS) && instance.ws) {
      try {
        instance.ws.close();
        instance.initializeWebSocket();
        logInfo(`→ ${label}: reconnected kline WS`);
      } catch (e) {
        logError(`→ ${label}: error reconnecting kline WS: ${e.message}`);
      }
    }

    // 2) execReportURL
    if (opts.execReportURL && instance.execWS) {
      try {
        instance.execWS.close();
        instance.initializeExecReportSocket();
        logInfo(`→ ${label}: reconnected exec-report WS`);
      } catch (e) {
        logError(`→ ${label}: error reconnecting exec-report WS: ${e.message}`);
      }
    }
  }

  /**
   * Retrieve a plugin (or array of plugin instances) by name.
   * @param {string} name
   */
  getPlugin(name) {
    return this.init[name];
  }
}

// Instantiate the manager with your initial configuration below.
// Adjust enabledPlugins or the per-plugin arrays/objects as needed.
module.exports = new PluginManager({
  
/*  enabledPlugins: [
    "ProfitLossPlugin",
    "AlphaBlendPlugin",
    "WilliamsRPlugin",
    "LDKJWhalePlugin",
    "AdxDiPlugin",
    "TradePlugin",
    "CMPivotBandsPlugin"
  ],
  
  
*/
  enabledPlugins: [
    //"AlphaBlendPlugin",
    "ProfitLossPlugin",
    "LDKJWhalePlugin",
    //"GoldenCrossPlugin",
    //"WilliamsRPlugin",
    //"AdxDiPlugin",
    //"TradePlugin",
    "OrderBookWallsPlugin",
    "LedgerOrderBookWallsPlugin"
  ],


  // OrderBookWallsPlugin: can have multiple instances, here one for XRPUSDT
  OrderBookWallsPlugin: [
    {
      cobWebSocketUrl: 'ws://192.168.0.91:8084', // Order book WebSocket (preferred)
      klineWS: 'ws://192.168.0.91:8080',
      symbol: 'XRPUSDT',
      duration: '1m',
      limit: 1,
      broadcastClientWS: 'ws://localhost:8083',
      priceRange: 0.03, // 1% range around mid-price (was 3%)
      pricePrecision: 4,
      priceGrouping: 0.005, // wider buckets (was 0.0005)
      wallPercentage: 4.0, // 4% of total volume to count as wall (was 5.0)
      wallProximityPercent: 0.003, // % distance from wall to trigger signal (default 0.4%)
      blockIntervalSeconds: 1
    }
  ],
  // LedgerOrderBookWallsPlugin: example config for XRP_RLUSD
  LedgerOrderBookWallsPlugin: [
    {
      cobWebSocketUrl: 'ws://localhost:8085?pair=XRP_USD_rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B',
      klineWS: 'ws://192.168.0.91:8080',
      // Example kline WS URL: http://192.168.0.91:8080/?symbol=XRPUSDT&duration=1m&limit=30
      symbol: 'XRPLUSD',
      duration: '1m',
      limit: 1,
      broadcastClientWS: 'ws://localhost:8083',
      priceRange: 0.03,
      pricePrecision: 4,
      priceGrouping: 0.005,
      wallPercentage: 4.0,
      wallProximityPercent: 0.3,
      blockIntervalSeconds: 1
    }
  ],

/*

    profitThreshold: 0.0270, // 0.0250 = 2.50% profit --> this is the take profit percentage
    lossThreshold: 0.0370, // 0.0350 = 3.50% loss --> this is the stop loss percentage
    killSwitchThreshold: 0.50,  // 0.50 = 50% of initial capital
    trailingStopThreshold: 0.50,
    realisedTP: 0.0270, // 0.02 = 2% realised take profit
    makerFeePct: 0.0075,  // 0.0075 = 0.75% maker fee
    takerFeePct: 0.0075,  // 0.0075 = 0.75% taker fee
    bnbDiscountPct: 0.0075, // 0.0075 = 0.75% BNB discount
    tradeProtection: false, // false means no trade protection.
    tradeRecyclingEnabled: false, // true means trade recycling is enabled.

  */


  // ProfitLossPlugin expects a single object
  ProfitLossPlugin: {
    WS: 'ws://192.168.0.91:8080',
    profitperTrade: 500,           // 500 USDT profit per trade
    profitThreshold: 0.0120,         // 1.2% profit threshold
    lossThreshold: 0.0230,           // 2.3% loss threshold
    killSwitchThreshold: 0.10,      // 10% of initial capital (to prevent total loss)
    trailingStopThreshold: 0.008,   // 0.8% trailing stop threshold
    realisedTP: 0.0210,             // 1.7% realised take profit
    makerFeePct: 0.07500,           // 0.075% maker fee (Binance standard)
    takerFeePct: 0.07500,           // 0.075% taker fee (Binance standard)
    bnbDiscountPct: 0.0006,         // 0.06% BNB discount (if you use BNB for fees)
    tradeProtection: false,          // true to auto-protect from fat finger/flash moves
    tradeRecyclingEnabled: true,    // Off unless you want to auto-recycle
    broadcastClientWS: 'ws://localhost:8083'
  },
  // GoldenCrossPlugin: single instance
  GoldenCrossPlugin: {
    WS: 'ws://192.168.0.91:8080',
    symbol: 'BTCUSDT',
    duration: '1m',
    limit: 500,
    broadcastClientWS: 'ws://localhost:8083',
    shortMAPeriod: 50,
    longMAPeriod: 200,
    redLine: 0.03,
    confirmationCandles: 3
  },

  // AlphaBlendPlugin can have multiple instances
  AlphaBlendPlugin: [
    {
      WS: 'ws://192.168.0.91:8080',
      symbol: 'XRPUSDT',
      duration: '1m',
      limit: 180,
      broadcastClientWS: 'ws://localhost:8083',
      trendReq: 'Trending',
      stickyTrend: true,
      length: 14,
      coeff: 1.0,
      signalTolerance: 0.005,
      referenceBarOffset: 2
    },
        {
      WS: 'ws://192.168.0.91:8080',
      symbol: 'ZROUSDT',
      duration: '1m',
      limit: 180,
      broadcastClientWS: 'ws://localhost:8083',
      trendReq: 'Trending',
      stickyTrend: true,
      length: 14,
      coeff: 1.0,
      signalTolerance: 0.005,
      referenceBarOffset: 2
    },
            {
      WS: 'ws://192.168.0.91:8080',
      symbol: 'ETHUSDT',
      duration: '1m',
      limit: 180,
      broadcastClientWS: 'ws://localhost:8083',
      trendReq: 'Trending',
      stickyTrend: true,
      length: 14,
      coeff: 1.0,
      signalTolerance: 0.005,
      referenceBarOffset: 2
    }
  ],

  // WilliamsRPlugin can also have multiple instances
  WilliamsRPlugin: [
    {
      WS: 'ws://192.168.0.91:8080',
      symbol: 'XRPUSDT',
      duration: '1m',
      limit: 180,
      broadcastClientWS: 'ws://localhost:8083',
      trendReq: 'Ranging',
      length: 21,
      emaLength: 7,
      buyWilly: -80,
      sellWilly: -5,
      sellEmaThreshold: -5,
      buyEmaThreshold: -90
    },
    {
      WS: 'ws://192.168.0.91:8080',
      symbol: 'ZROUSDT',
      duration: '1m',
      limit: 180,
      broadcastClientWS: 'ws://localhost:8083',
      trendReq: 'Ranging',
      length: 21,
      emaLength: 7,
      buyWilly: -80,
      sellWilly: -5,
      sellEmaThreshold: -5,
      buyEmaThreshold: -90
    }
  ],

  // LDKJWhalePlugin: three instances
  LDKJWhalePlugin: [
    {
      WS: 'ws://192.168.0.91:8080',
      symbol: 'XRPUSDT',
      duration: '1m',
      limit: 180,
      broadcastClientWS: 'ws://localhost:8083',
      trendReq: 'Ranging',
      BuyAlertLimit: 5,
      SellAlertLimit: 90,
      n1: 18,
      m1: 4,
      m2: 4
    },
    {
      WS: 'ws://192.168.0.91:8080',
      symbol: 'BTCUSDT',
      duration: '1m',
      limit: 180,
      broadcastClientWS: 'ws://localhost:8083',
      trendReq: 'Ranging',
      BuyAlertLimit: 5,
      SellAlertLimit: 90,
      n1: 18,
      m1: 4,
      m2: 4
    },
    {
      WS: 'ws://192.168.0.91:8080',
      symbol: 'ETHUSDT',
      duration: '1m',
      limit: 360,
      broadcastClientWS: 'ws://localhost:8083',
      trendReq: 'Ranging',
      BuyAlertLimit: 5,
      SellAlertLimit: 90,
      n1: 18,
      m1: 4,
      m2: 4
    }
  ],
  

  // AdxDiPlugin: three instances
  AdxDiPlugin: [
    {
      WS: 'ws://192.168.0.91:8080',
      symbol: 'XRPUSDT',
      duration: '1m',
      limit: 180,
      broadcastClientWS: 'ws://localhost:8083',
      length: 24,
      trendThreshold: 25,
      smoothingLength: 8
    },
    {
      WS: 'ws://192.168.0.91:8080',
      symbol: 'ZROUSDT',
      duration: '1m',
      limit: 180,
      broadcastClientWS: 'ws://localhost:8083',
      length: 24,
      trendThreshold: 25,
      smoothingLength: 8
    },
    {
      WS: 'ws://192.168.0.91:8080',
      symbol: 'ETHUSDT',
      duration: '1m',
      limit: 180,
      broadcastClientWS: 'ws://localhost:8083',
      length: 24,
      trendThreshold: 25,
      smoothingLength: 8
    }
  ],
  

  // TradePlugin: single instance
  TradePlugin: {
    broadcastClientWS: 'ws://localhost:8083'
  },

  // CMPivotBandsPlugin: two instances plus added AXLUSDT instance
  CMPivotBandsPlugin: [
    {
      WS: 'ws://192.168.0.91:8080',
      symbol: 'XRPUSDT',
      duration: '1m',
      period: 7,
      emaLength: 7,
      broadcastClientWS: 'ws://localhost:8083'
    },
    {
      WS: 'ws://192.168.0.91:8080',
      symbol: 'ZROUSDT',
      duration: '1m',
      period: 7,
      emaLength: 7,
      broadcastClientWS: 'ws://localhost:8083'
    }
  ]
});
