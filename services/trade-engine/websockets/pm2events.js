'use strict';

const pm2 = require('pm2');
const logger = require('../logger'); // Ensure your logger has logInfo, logError, etc.

/**
 * PM2Events class encapsulates a persistent connection to PM2.
 * It caches worker IDs and provides methods to send messages
 * to all PM2-managed processes and register local event handlers.
 */
class PM2Events {
  constructor() {
    this.isConnected = false;
    this.workerIds = [];
    this.eventHandlers = {}; // Handlers indexed by topic
    this._initConnection();

    // Listen for messages from PM2-managed processes and dispatch them
    process.on('message', (message) => {
      this._dispatchMessage(message);
    });
  }

  /**
   * Establishes a persistent connection to PM2 and caches worker IDs.
   * If connection fails, an error is logged.
   */
  _initConnection() {
    pm2.connect((err) => {
      if (err) {
        logger.logError(`Failed to connect to PM2: ${err}`);
        return;
      }
      this.isConnected = true;
      pm2.list((err, processList) => {
        if (err) {
          logger.logError(`Failed to list PM2 processes: ${err}`);
          return;
        }
        this.workerIds = processList.map(proc => proc.pm2_env.pm_id);
        logger.logInfo("PM2 connected and worker IDs stored:", this.workerIds);
      });
      // Do not disconnect here—keep the connection alive.
    });
  }

  /**
   * Registers an event handler for a specific topic.
   *
   * @param {string} topic - The topic to listen for.
   * @param {function} callback - The function to call when an event is received.
   */
  on(topic, callback) {
    if (!this.eventHandlers[topic]) {
      this.eventHandlers[topic] = [];
    }
    this.eventHandlers[topic].push(callback);
  }

  /**
   * Dispatches an incoming message to all registered handlers for its topic.
   *
   * @param {Object} message - The incoming message.
   */
  _dispatchMessage(message) {
    if (message && message.topic && this.eventHandlers[message.topic]) {
      this.eventHandlers[message.topic].forEach(callback => callback(message));
    }
  }

  /**
   * Sends an event to all PM2-managed processes with retry logic.
   *
   * @param {string} topic - The event topic.
   * @param {string} type - The event type.
   * @param {Object} data - The data payload.
   * @param {function} [callback] - Optional callback after sending.
   * @param {number} [retryCount=3] - Number of retry attempts.
   */
  send(topic, type, data, callback, retryCount = 3) {
    if (!this.isConnected) {
      if (retryCount > 0) {
        logger.logError(`PM2 not connected, retrying... (${retryCount} attempts left)`);
        setTimeout(() => this.send(topic, type, data, callback, retryCount - 1), 1000);
      } else {
        logger.logError("PM2 not connected, cannot send message after retries.");
        if (callback) callback(new Error("PM2 not connected"));
      }
      return;
    }
    // Send the message to every worker
    this.workerIds.forEach((workerId) => {
      pm2.sendDataToProcessId(workerId, {
        type: type,
        data: data,
        id: workerId,
        topic: topic
      }, (err, res) => {
        if (err) {
          logger.logError(`Error sending data to process ${workerId}:`, err);
        }
      });
    });
    if (callback) callback(null);
  }

  /**
   * Sends an event message to a specific PM2 process with retry logic.
   *
   * @param {number|string} processId - The target process ID.
   * @param {string} topic - The event topic.
   * @param {string} type - The event type.
   * @param {Object} data - The data payload.
   * @param {function} [callback] - Optional callback executed after sending.
   * @param {number} [retryCount=3] - Number of retry attempts.
   */
  sendTo(processId, topic, type, data, callback, retryCount = 3) {
    if (!this.isConnected) {
      if (retryCount > 0) {
        logger.logError(`PM2 not connected, retrying... (${retryCount} attempts left)`);
        setTimeout(() => this.sendTo(processId, topic, type, data, callback, retryCount - 1), 1000);
      } else {
        logger.logError("PM2 not connected, cannot send message after retries.");
        if (callback) callback(new Error("PM2 not connected"));
      }
      return;
    }
    pm2.sendDataToProcessId(processId, {
      type: type,
      data: data,
      id: processId,
      topic: topic
    }, (err, res) => {
      if (err) {
        logger.logError(`Error sending data to process ${processId}:`, err);
      } else {
        logger.logInfo(`Message sent to process ${processId} on topic '${topic}' with event type '${type}': ${JSON.stringify(data)}`);
      }
      if (callback) callback(err, res);
    });
  }
}

// Export a singleton instance of PM2Events.
module.exports = new PM2Events();
