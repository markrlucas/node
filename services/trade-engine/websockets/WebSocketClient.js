// WebSocketClient.js
// This module works in both Node and browser environments.
// In Node, install the 'ws' package and require it.
(function (global, factory) {
    if (typeof module === 'object' && module.exports) {
      module.exports = factory(require('ws'));
    } else {
      global.WebSocketClient = factory(global.WebSocket);
    }
  }(this, function (WebSocket) {
    'use strict';
  
    class WebSocketClient {
      /**
       * Creates a new WebSocketClient.
       * @param {string} url - The WebSocket server URL.
       * @param {object} [options] - Optional settings.
       * @param {number} [options.reconnectInterval=5000] - Time (ms) between reconnection attempts.
       * @param {number} [options.maxRetries=Infinity] - Maximum reconnection attempts.
       */
      constructor(url, options = {}) {
        this.url = url;
        this.options = options;
        this.reconnectInterval = options.reconnectInterval || 5000;
        this.maxRetries = options.maxRetries || Infinity;
        this.retryCount = 0;
        this.eventListeners = {}; // Event callback registry.
        this.connect();
      }
  
      /**
       * Connect to the WebSocket server.
       */
      connect() {
        this.ws = new WebSocket(this.url);
  
        // Handle connection open event.
        this.ws.onopen = () => {
          this.retryCount = 0;
          this.emit('open');
        };
  
        // Handle incoming messages.
        this.ws.onmessage = (event) => {
          let data = event.data;
          // Attempt to parse JSON; if it fails, leave data as-is.
          try {
            data = JSON.parse(data);
          } catch (e) {
            // Not a JSON message—leave it unchanged.
          }
          this.emit('message', data);
        };
  
        // Handle errors.
        this.ws.onerror = (error) => {
          this.emit('error', error);
        };
  
        // Handle connection close and optionally reconnect.
        this.ws.onclose = () => {
          this.emit('close');
          if (this.retryCount < this.maxRetries) {
            setTimeout(() => {
              this.retryCount++;
              this.connect();
            }, this.reconnectInterval);
          }
        };
      }
  
      /**
       * Send a message via the WebSocket.
       * @param {object|string} data - The data to send. If an object is provided, it will be JSON-stringified.
       */
      send(data) {
        if (this.ws.readyState === WebSocket.OPEN) {
          const message = typeof data === 'object' ? JSON.stringify(data) : data;
          this.ws.send(message);
        } else {
          console.error('WebSocket is not open. ReadyState:', this.ws.readyState);
        }
      }
  
      /**
       * Register an event listener.
       * @param {string} event - The event name ('open', 'message', 'error', 'close').
       * @param {function} callback - The callback function.
       */
      on(event, callback) {
        if (!this.eventListeners[event]) {
          this.eventListeners[event] = [];
        }
        this.eventListeners[event].push(callback);
      }
  
      /**
       * Remove a previously registered event listener.
       * @param {string} event - The event name.
       * @param {function} callback - The callback function to remove.
       */
      off(event, callback) {
        if (!this.eventListeners[event]) return;
        this.eventListeners[event] = this.eventListeners[event].filter(cb => cb !== callback);
      }
  
      /**
       * Emit an event to all registered listeners.
       * @param {string} event - The event name.
       * @param {...any} args - Arguments to pass to the callbacks.
       */
      emit(event, ...args) {
        if (!this.eventListeners[event]) return;
        this.eventListeners[event].forEach(callback => callback(...args));
      }
    }
  
    return WebSocketClient;
  }));
  
