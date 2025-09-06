/**
 * @fileoverview
 * Manages the lifecycle of WebSocket services, specifically for BinanceCOB.
 * Provides methods to start, stop, and get the status of WebSocket services.
 * 
 * # Usage
 * 
 * To use this manager, instantiate it with a configuration object and call `start()`:
 * 
 * ```js
 * const WebSocketManager = require('./services/websocketManager');
 * const config = {
 *   binanceCOB: {
 *     symbols: ['BTCUSDT', 'ETHUSDT'],
 *     port: 8084,
 *   }
 * };
 * const manager = new WebSocketManager(config);
 * manager.start();
 * ```
 * 
 * To gracefully stop all services (e.g., on shutdown):
 * 
 * ```js
 * await manager.stop();
 * ```
 * 
 * To get the current status of all running services:
 * 
 * ```js
 * const status = manager.getStatus();
 * console.log(status);
 * ```
 * 
 * # Command Line
 * 
 * You can run this script directly:
 * 
 * ```
 * node services/websocketManager.js
 * ```
 * 
 * Or with PM2:
 * 
 * ```
 * pm2 start websocketManager.js --name <SERVICENAME> --log-date-format "HH:mm DD-MM-YYYY Z"
 * ```
 * 
 * @class WebSocketManager
 * @classdesc Manages the lifecycle (start, stop, status) of WebSocket services.
 * @param {Object} serviceConfig - Configuration object for WebSocket services.
 * @param {Object} serviceConfig.binanceCOB - BinanceCOB service configuration.
 * @param {string[]} serviceConfig.binanceCOB.symbols - List of trading pairs to track.
 * @param {number} serviceConfig.binanceCOB.port - Port number for the WebSocket server.
 * 
 * @method start
 * @description Starts all configured WebSocket services.
 * @returns {Promise<void>}
 * 
 * @method stop
 * @description Stops all running WebSocket services.
 * @returns {Promise<void>}
 * 
 * @method getStatus
 * @description Gets the status of all running services.
 * @returns {Object} Status object with details of running services.
 */
// services/websocketManager.js
//pm2 start websocketManager.js --name BinanceCOB --log-date-format "HH:mm DD-MM-YYYY Z"


const BinanceCOB = require('./binanceCOB');

/**
 * Configuration for all WebSocket services.
 * In a real application, this might come from a .json file or environment variables.
 */
const config = {
  binanceCOB: {
    symbols: ['BTCUSDT', 'XRPUSDT', 'ETHUSDT'], // List of trading pairs to track
    port: 8084,
  }
};

/**
 * Manages the lifecycle of WebSocket services.
 */
class WebSocketManager {
  constructor(serviceConfig) {
    this.config = serviceConfig;
    this.services = {};
  }

  /**
   * Starts all configured WebSocket services.
   */
  async start() {
    console.log('Starting WebSocket services...');

    try {
      if (this.config.binanceCOB) {
        const { symbols, port } = this.config.binanceCOB;

        if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
          throw new Error('BinanceCOB configuration must include a non-empty symbols array');
        }
        if (!port || typeof port !== 'number' || port < 1 || port > 65535) {
          throw new Error('BinanceCOB configuration must include a valid port number');
        }

        console.log(`Initializing BinanceCOB with symbols: ${symbols.join(', ')} on port ${port}`);
        this.services.binanceCOB = new BinanceCOB(symbols, port);
        console.log(`BinanceCOB service started successfully on port ${port}`);
      }

      console.log('All configured WebSocket services have been started.');
    } catch (error) {
      console.error('Failed to start WebSocket services:', error.message);
      throw error;
    }
  }

  /**
   * Stops all running WebSocket services.
   */
  async stop() {
    console.log('Stopping WebSocket services...');

    try {
      if (this.services.binanceCOB) {
        await this.services.binanceCOB.stop();
        delete this.services.binanceCOB;
        console.log('BinanceCOB service stopped');
      }

      console.log('All WebSocket services have been stopped.');
    } catch (error) {
      console.error('Error stopping WebSocket services:', error.message);
      throw error;
    }
  }

  /**
   * Gets the status of all services.
   */
  getStatus() {
    const status = {};

    if (this.services.binanceCOB) {
      status.binanceCOB = {
        symbols: this.services.binanceCOB.symbols,
        port: this.config.binanceCOB.port,
        running: true
      };
    }

    return status;
  }
}

// This allows the script to be run directly from the command line.
if (require.main === module) {
  const manager = new WebSocketManager(config);

  process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT. Gracefully shutting down...');
    try {
      await manager.stop();
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error.message);
      process.exit(1);
    }
  });

  process.on('SIGTERM', async () => {
    console.log('\nReceived SIGTERM. Gracefully shutting down...');
    try {
      await manager.stop();
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error.message);
      process.exit(1);
    }
  });

  manager.start().catch((error) => {
    console.error('Failed to start WebSocket manager:', error.message);
    process.exit(1);
  });
}

module.exports = WebSocketManager;