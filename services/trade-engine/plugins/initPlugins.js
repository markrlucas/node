// plugins/InitPlugins.js
const logger           = require('../logger');
const AdxDiPlugin      = require('./AdxDiPlugin');
const AlphaBlendPlugin = require('./AlphaBlendPlugin');
const WilliamsRPlugin  = require('./WilliamsRPlugin');
const GoldenCrossPlugin = require('./GoldenCrossPlugin');
const LDKJWhalePlugin  = require('./LDKJWhalePlugin');
const ProfitLossPlugin = require('./ProfitLosslPlugin');
const TradePlugin      = require('./TradePlugin');
const CMPivotBandsPlugin = require('./CMPivotBandsPlugin');
const OrderBookWallsPlugin = require('./OrderBookWallsPlugin');
const LedgerOrderBookWallsPlugin = require('./LedgerOrderBookWallsPlugin');

class InitPlugins {
  /**
   * @param {Object} options
   *   Shape: {
   *     enabledPlugins: [...],
   *     AdxDiPlugin: [ {…}, {…} ], 
   *     AlphaBlendPlugin: [ {…}, {…} ],
   *     WilliamsRPlugin: [ {…}, {…} ],
   *     LDKJWhalePlugin: [ {…}, {…} ],
   *     ProfitLossPlugin: { … },
   *     TradePlugin: { … }
   *   }
   */
  constructor(options = {}) {
    this.config = options;
    const enabled = new Set(options.enabledPlugins || []);

    // Map plugin name → { PluginClass, defaults }
    this.pluginsConfig = {
      AdxDiPlugin: {
        PluginClass: AdxDiPlugin,
        defaults: {
        }
      },
      AlphaBlendPlugin: {
        PluginClass: AlphaBlendPlugin,
        defaults: {
          // Required for every instance:        
        }
      },
      WilliamsRPlugin: {
        PluginClass: WilliamsRPlugin,
        defaults: {
        }
      },
      LDKJWhalePlugin: {
        PluginClass: LDKJWhalePlugin,
        defaults: {
        }
      },
      OrderBookWallsPlugin: {
        PluginClass: OrderBookWallsPlugin,
        defaults: {
        }
      },
      LedgerOrderBookWallsPlugin: {
        PluginClass: LedgerOrderBookWallsPlugin,
        defaults: {
        }
      },
      ProfitLossPlugin: {
        PluginClass: ProfitLossPlugin,
        defaults: {
        }
      },
      TradePlugin: {
        PluginClass: TradePlugin,
        defaults: {
        }
      },
      CMPivotBandsPlugin: {
        PluginClass: CMPivotBandsPlugin,
        defaults: {
        }
      },
      GoldenCrossPlugin: {
        PluginClass: GoldenCrossPlugin,
        defaults: {
        }
      }
    };

    // Only instantiate enabled plugins
    for (const key of Object.keys(this.pluginsConfig)) {
      if (!enabled.has(key)) {
        logger.logInfo(`InitPlugins: skipping disabled plugin "${key}"`);
        continue;
      }
      const raw = this.config[key];
      if (Array.isArray(raw)) {
        this[key] = raw.map(opts => {
          const merged = { ...this.pluginsConfig[key].defaults, ...opts };
          return new this.pluginsConfig[key].PluginClass(merged);
        });
      } else {
        const merged = { ...this.pluginsConfig[key].defaults, ...(raw || {}) };
        this[key] = new this.pluginsConfig[key].PluginClass(merged);
      }
    }
  }

  /**
   * Only update the plugin(s) you passed in via `options`.
   * @param {Object} options
   *   E.g. {
   *     AlphaBlendPlugin: [ { stickyTrend: false }, { stickyTrend: true } ],
   *     ProfitLossPlugin: { profitPct: 0.05 },
   *     AdxDiPlugin: [ { length: 30 }, { length: 12 } ]
   *   }
   */
  updateParams(options = {}) {
    const enabled = new Set(this.config.enabledPlugins || []);

    // 1) First, merge raw overrides into this.config
    for (const pluginName of Object.keys(options)) {
      if (Array.isArray(options[pluginName])) {
        this.config[pluginName] = options[pluginName]; // direct replace for arrays
      } else {
        this.config[pluginName] = {
          ...(this.config[pluginName] || {}),
          ...options[pluginName]
        };
      }
    }

    // 2) Only update enabled plugins
    for (const pluginName of Object.keys(options)) {
      if (!enabled.has(pluginName)) {
        logger.logInfo(`InitPlugins.updateParams: skipping disabled plugin "${pluginName}"`);
        continue;
      }

      if (!this.pluginsConfig[pluginName]) {
        logger.logWarn(`InitPlugins.updateParams: unknown plugin "${pluginName}", skipping.`);
        continue;
      }

      const rawOpts = this.config[pluginName];

      if (Array.isArray(rawOpts)) {
        // Check if the array length matches
        if (!this[pluginName] || this[pluginName].length !== rawOpts.length) {
          // Rebuild all instances from config!
          this[pluginName] = rawOpts.map((opts) => {
            const merged = { ...this.pluginsConfig[pluginName].defaults, ...opts };
            return new this.pluginsConfig[pluginName].PluginClass(merged);
          });
          logger.logInfo(`InitPlugins: ${pluginName} instance array rebuilt from config.`);
        }

        // Now update each instance
        this[pluginName].forEach((instance, idx) => {
          const optsForThisIdx = rawOpts[idx] || {};
          if (typeof instance.updateParams === 'function') {
            instance.updateParams(optsForThisIdx);
            logger.logInfo(`InitPlugins: ${pluginName}[${idx}] updated with new parameters.`);
          } else {
            logger.logWarn(`InitPlugins: ${pluginName}[${idx}] has no updateParams(), skipping.`);
          }
        });
      } else {
        // Single-instance plugin
        const mergedOpts = { ...this.pluginsConfig[pluginName].defaults, ...rawOpts };
        const instance = this[pluginName];

        if (!instance) {
          // If someone disabled then re-enabled mid-flight, you could recreate here
          this[pluginName] = new this.pluginsConfig[pluginName].PluginClass(mergedOpts);
          if (typeof this[pluginName].startPlugin === 'function') {
            this[pluginName].startPlugin();
          }
          logger.logInfo(`InitPlugins: ${pluginName} was not instantiated and has been created.`);
        } else if (typeof instance.updateParams === 'function') {
          instance.updateParams(mergedOpts);
          logger.logInfo(`InitPlugins: ${pluginName} updateParams() called.`);
        } else {
          logger.logWarn(`InitPlugins: ${pluginName} does not support updateParams(), skipping.`);
        }
      }
    }
  }
}


module.exports = InitPlugins;
