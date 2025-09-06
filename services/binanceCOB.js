const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'jsons');

/**
 * Utility: Format a Date object into UK date string: dd-mm-yyyy.
 */
function formatUKDate(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

/**
 * BinanceCOB: Consolidated Order Book WebSocket Service
 * Streams live order book updates from Binance and broadcasts to local clients.
 */
class BinanceCOB {
  /**
   * @param {string[]} symbols - List of trading pairs (e.g. ['BTCUSDT', 'ETHUSDT']).
   * @param {number} port - Local WebSocket server port.
   */
  constructor(symbols, port = 8084) {
    this.symbols = symbols.map(s => s.toUpperCase());
    this.port = port;
    this.orderBooks = {};    // In-memory snapshots { [symbol]: { lastUpdateId, bids, asks } }
    this.binanceWS = {};     // Binance WebSocket connections
    this.isRunning = false;
    this.historicalData = {}; // Store historical order book snapshots
    this.snapshotInterval = 5000; // Take snapshot every 5 seconds

    // Initialize local WebSocket server for clients
    this.localWSS = new WebSocket.Server({ port: this.port });
    this.localWSS.on('connection', this._handleClient.bind(this));

    console.log(`BinanceCOB service initialized with symbols [${this.symbols.join(', ')}] on port ${this.port}`);

    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR);
    }

    // Kick everything off
    this._init();
  }

  /**
   * Initialize snapshots and WS connections
   */
  async _init() {
    try {
      console.log(`Initializing BinanceCOB for symbols: ${this.symbols.join(', ')}`);
      this.isRunning = true;  // Set running flag early
      
      // Initialize historical data storage for each symbol
      for (const symbol of this.symbols) {
        await this._initializeHistoricalStorage(symbol);
      }
      
      // Fetch initial snapshots in parallel
      await Promise.all(this.symbols.map(sym => this._resetOrderBook(sym)));
      
      // Connect to Binance depth streams
      this.symbols.forEach(sym => this._connectDepthWS(sym));
      
      // Start periodic snapshot saving
      this._startSnapshotInterval();
      
      console.log(`BinanceCOB service is now running and serving on ws://localhost:${this.port}`);
    } catch (error) {
      console.error('Failed to initialize BinanceCOB:', error.message);
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Initialize historical data storage for a symbol
   * @param {string} symbol
   */
  async _initializeHistoricalStorage(symbol) {
    const obFilePath = path.join(DATA_DIR, `${symbol.toLowerCase()}-orderbook.json`);
    
    if (!fs.existsSync(obFilePath)) {
      fs.writeFileSync(obFilePath, JSON.stringify([]));
      console.log(`[${symbol}] Created order book history file.`);
    }
    
    this.historicalData[symbol] = [];
  }

  /**
   * Start background processes - snapshot saving is completely separate from client updates
   */
  _startSnapshotInterval() {
    // Background snapshot saving every 30 seconds (much less frequent)
    // This runs in background and NEVER interferes with client updates
    this.snapshotTimer = setInterval(() => {
      // Use setImmediate to ensure this never blocks client updates
      setImmediate(() => {
        this.symbols.forEach(symbol => {
          if (this.orderBooks[symbol]) {
            this._saveSnapshot(symbol);
          }
        });
      });
    }, 30000); // 30 seconds - disk I/O should be minimal

    // NO periodic sync timer - clients get updates immediately when data changes
    // This eliminates any artificial delays or interference
  }

  /**
   * Save current order book snapshot to historical data
   * CRITICAL: This NEVER blocks client updates - runs completely asynchronously
   * @param {string} symbol
   */
  _saveSnapshot(symbol) {
    const book = this.orderBooks[symbol];
    if (!book) return;

    try {
      const snapshot = {
        timestamp: Date.now(),
        lastUpdateId: book.lastUpdateId,
        bids: book.bids.slice(0, 20), // Keep top 20 levels
        asks: book.asks.slice(0, 20)
      };

      // Add to in-memory storage immediately (no blocking operations)
      this.historicalData[symbol].unshift(snapshot);
      
      // Keep only last 200 snapshots in memory (reduce memory footprint)
      if (this.historicalData[symbol].length > 200) {
        this.historicalData[symbol] = this.historicalData[symbol].slice(0, 200);
      }

      // Disk writes are done MUCH less frequently and asynchronously
      if (this.historicalData[symbol].length % 20 === 0) {
        // Use setImmediate to ensure disk I/O never blocks client updates
        setImmediate(() => {
          this._commitHistoricalDataAsync(symbol);
        });
      }
    } catch (err) {
      // Even errors in snapshot saving should not affect client updates
      console.error(`[${symbol}] Snapshot error (non-blocking): ${err.message}`);
    }
  }

  /**
   * Write historical data to disk - COMPLETELY ASYNCHRONOUS
   * This method NEVER blocks client updates
   * @param {string} symbol
   */
  _commitHistoricalDataAsync(symbol) {
    const filePath = path.join(DATA_DIR, `${symbol.toLowerCase()}-orderbook.json`);
    
    // Use setTimeout to ensure this runs in next tick, never blocking current operations
    setTimeout(() => {
      try {
        let diskData = [];
        if (fs.existsSync(filePath)) {
          diskData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
        
        // Merge and sort by timestamp (newest first)
        const combined = [...this.historicalData[symbol], ...diskData]
          .sort((a, b) => b.timestamp - a.timestamp);
        
        // Keep only last 2 hours of data (much smaller for performance)
        const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
        const filtered = combined.filter(item => item.timestamp > twoHoursAgo);
        
        // Keep maximum 1000 snapshots to prevent file bloat
        const final = filtered.slice(0, 1000);
        
        fs.writeFileSync(filePath, JSON.stringify(final));
        // Minimal logging to avoid console spam
        if (final.length % 100 === 0) {
          console.log(`[${symbol}] Disk: ${final.length} snapshots committed`);
        }
      } catch (err) {
        console.error(`[${symbol}] Disk write error (non-blocking): ${err.message}`);
      }
    }, 0);
  }

  /**
   * Get historical order book data for a symbol
   * @param {string} symbol
   * @param {number} limit - Number of snapshots to return
   * @returns {Array} Historical snapshots
   */
  getHistoricalData(symbol, limit) {
    console.log(`[${symbol}] Requesting ${limit} historical snapshots.`);
    
    // First try in-memory data
    let historicalSnapshots = this.historicalData[symbol] || [];
    
    // If we need more data, load from disk
    if (historicalSnapshots.length < limit) {
      const filePath = path.join(DATA_DIR, `${symbol.toLowerCase()}-orderbook.json`);
      
      if (fs.existsSync(filePath)) {
        try {
          const diskData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (Array.isArray(diskData)) {
            // Combine and deduplicate by timestamp
            const combined = [...historicalSnapshots, ...diskData];
            const unique = combined.filter((item, index, arr) => 
              arr.findIndex(x => x.timestamp === item.timestamp) === index
            );
            historicalSnapshots = unique.sort((a, b) => b.timestamp - a.timestamp);
          }
        } catch (err) {
          console.error(`[${symbol}] Error reading historical data: ${err.message}`);
        }
      }
    }
    
    // Return requested number of snapshots (newest first)
    const result = historicalSnapshots.slice(0, limit);
    console.log(`[${symbol}] Returning ${result.length} historical snapshots.`);
    
    return result;
  }

  /**
   * Fetch full order book snapshot via REST and store in memory
   * @param {string} symbol
   */
  async _resetOrderBook(symbol) {
    try {
      const response = await axios.get('https://api.binance.com/api/v3/depth', {
        params: { symbol, limit: 1000 }
      });
      const { lastUpdateId, bids, asks } = response.data;
      this.orderBooks[symbol] = { lastUpdateId, bids, asks };
      console.log(`Snapshot loaded for ${symbol}: lastUpdateId=${lastUpdateId}`);
    } catch (err) {
      console.error(`Failed to fetch snapshot for ${symbol}:`, err.message);
      // Retry after delay
      setTimeout(() => this._resetOrderBook(symbol), 5000);
    }
  }

  /**
   * Connect to Binance depth WebSocket and handle updates
   * @param {string} symbol
   */
  _connectDepthWS(symbol) { 
    const baseUrl = 'wss://stream.binance.com:9443/ws';
    // Use fastest stream available - no buffering
    const stream = `${symbol.toLowerCase()}@depth`;
    const ws = new WebSocket(`${baseUrl}/${stream}`);

    ws.on('open', () => {
      console.log(`Depth WS connected for ${symbol} (real-time stream)`);
    });

    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);
        if (data.e !== 'depthUpdate') return;

        const book = this.orderBooks[symbol];
        if (!book) {
          console.warn(`[${symbol}] No order book found for depth update`);
          return;
        }

        // Add debug logging to see if updates are coming from Binance
        if (!this._binanceUpdateCounter) this._binanceUpdateCounter = {};
        if (!this._binanceUpdateCounter[symbol]) this._binanceUpdateCounter[symbol] = 0;
        this._binanceUpdateCounter[symbol]++;
        
        if (this._binanceUpdateCounter[symbol] % 100 === 0) {
          console.log(`[${symbol}] Received ${this._binanceUpdateCounter[symbol]} updates from Binance`);
        }

        // Ensure update continuity
        if (data.U <= book.lastUpdateId + 1 && data.u >= book.lastUpdateId + 1) {
          // PRIORITY 1: Update the order book immediately
          this._applyDeltas(book, data.b, data.a);
          book.lastUpdateId = data.u;
          
          // PRIORITY 2: Broadcast to clients IMMEDIATELY - no delays, no setImmediate
          this._broadcastLiveUpdate(symbol, data);
          
        } else if (data.U > book.lastUpdateId + 1) { // Handle future updates and resync
          console.warn(`[${symbol}] Out-of-sync for ${symbol}. Expected: ${book.lastUpdateId + 1}, Got: ${data.U}`);
          // Resync immediately but don't await - never block the message loop
          this._resetOrderBook(symbol).then(() => {
            // Send resync to clients immediately after reset
            this._broadcastResync(symbol);
          });
        }
      } catch (err) {
        console.error(`Error processing depthUpdate for ${symbol}:`, err.message);
      }
    });

    ws.on('close', () => {
      console.warn(`Depth WS closed for ${symbol}. Reconnecting in 5s...`);
      setTimeout(() => this._connectDepthWS(symbol), 5000);
    });

    ws.on('error', (err) => {
      console.error(`Depth WS error for ${symbol}:`, err.message);
      ws.close();
    });

    this.binanceWS[symbol] = ws;
  }

  /**
   * Apply bid/ask deltas to in-memory book
   * @param {{ bids: any[], asks: any[] }} book
   * @param {Array<[string,string]>} bids
   * @param {Array<[string,string]>} asks
   */
  _applyDeltas(book, bids, asks) {
    [['bids', bids], ['asks', asks]].forEach(([sideKey, deltas]) => {
      const side = book[sideKey];
      deltas.forEach(([price, qty]) => {
        const index = side.findIndex(([p]) => p === price);
        if (+qty === 0) {
          if (index > -1) side.splice(index, 1);
        } else if (index === -1) {
          side.push([price, qty]);
        } else {
          side[index][1] = qty;
        }
      });
    });

    // Sort order book: bids descending (highest first), asks ascending (lowest first)
    book.bids.sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]));
    book.asks.sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));
  }

  /**
   * Handle new client connections to local WS server
   * @param {WebSocket} ws
   * @param {http.IncomingMessage} req
   */
  _handleClient(ws, req) {
    const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
    const symbol = params.get('symbol')?.toUpperCase();
    const limit = params.get('limit'); // Number of historical snapshots requested
    
    if (!symbol || !this.orderBooks[symbol]) {
      ws.send(JSON.stringify({ error: 'Invalid or unsupported symbol' }));
      ws.close();
      return;
    }

    console.log(`Client connected for ${symbol}${limit ? ` with ${limit} historical snapshots` : ' (live only)'}`);
    console.log(`[${symbol}] Total clients now: ${Array.from(this.localWSS.clients).filter(c => c.symbol === symbol).length}`);

    // Add to local broadcast list immediately so they get live updates
    ws.symbol = symbol; // Tag client with its subscribed symbol
    ws.connectTime = Date.now(); // Track connection time for debugging
    
    // Add debugging to see what the client is requesting
    console.log(`[${symbol}] Client URL: ${req.url}`);
    
    // Note: WebSocket.Server automatically adds clients to this.localWSS.clients

    // If historical data is requested, send it first
    if (limit && parseInt(limit) > 0) {
      const historicalSnapshots = this.getHistoricalData(symbol, parseInt(limit));
      
      console.log(`[${symbol}] Sending ${historicalSnapshots.length} historical snapshots to client.`);
      
      // Send historical snapshots in chronological order (oldest first)
      const reversedSnapshots = historicalSnapshots.reverse();
      reversedSnapshots.forEach((snapshot, index) => {
        ws.send(JSON.stringify({ 
          type: 'historical',
          sequence: index + 1,
          total: reversedSnapshots.length,
          snapshot: {
            lastUpdateId: snapshot.lastUpdateId,
            bids: snapshot.bids,
            asks: snapshot.asks
          },
          ts: snapshot.timestamp 
        }));
      });

      // Send a marker indicating end of historical data
      ws.send(JSON.stringify({ 
        type: 'historical_complete', 
        message: 'Historical data complete. Switching to real-time feed.',
        ts: Date.now() 
      }));
      
      // Small pause before sending current snapshot using optimized method
      setTimeout(() => {
        console.log(`[${symbol}] Sending current live snapshot to client.`);
        this._sendSnapshotToClient(ws, symbol);
      }, 50); // Reduced to 50ms for even faster startup
    } else {
      // Send current snapshot immediately for live-only clients using optimized method
      this._sendSnapshotToClient(ws, symbol);
      console.log(`[${symbol}] Sent immediate live snapshot to client.`);
    }

    ws.on('close', () => {
      const connectionTime = Date.now() - ws.connectTime;
      console.log(`Client disconnected from ${symbol} after ${connectionTime}ms`);
      console.log(`[${symbol}] Remaining clients: ${Array.from(this.localWSS.clients).filter(c => c.symbol === symbol && c.readyState === WebSocket.OPEN).length}`);
    });

    ws.on('error', (err) => {
      const connectionTime = Date.now() - ws.connectTime;
      console.error(`[${symbol}] Client connection error after ${connectionTime}ms: ${err.message}`);
    });

    // Add message logging to see what we're sending to this specific client
    const originalSend = ws.send.bind(ws);
    ws.send = function(data) {
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'depth_update') {
          console.log(`[${symbol}] Sending depth_update to client: updateId=${parsed.data.u}, bids=${parsed.data.b.length}, asks=${parsed.data.a.length}`);
        } else {
          console.log(`[${symbol}] Sending ${parsed.type} to client`);
        }
      } catch (e) {
        console.log(`[${symbol}] Sending non-JSON data to client`);
      }
      return originalSend(data);
    };
  }

  /**
   * Broadcast live order book update to all connected clients
   * CRITICAL: This must be ULTRA-FAST with zero blocking operations
   * @param {string} symbol
   * @param {Object} depthUpdate - The Binance depth update data
   */
  _broadcastLiveUpdate(symbol, depthUpdate) {
    // Pre-filter clients once for efficiency
    const symbolClients = Array.from(this.localWSS.clients).filter(
      client => client.symbol === symbol && client.readyState === WebSocket.OPEN
    );

    if (symbolClients.length === 0) return;

    // Pre-serialize message once for all clients
    const message = JSON.stringify({
      type: 'depth_update',
      symbol: symbol,
      data: {
        e: depthUpdate.e,
        E: depthUpdate.E,
        s: depthUpdate.s,
        U: depthUpdate.U,
        u: depthUpdate.u,
        b: depthUpdate.b,
        a: depthUpdate.a
      },
      ts: Date.now()
    });

    // Send to all clients immediately - no error handling that could slow things down
    let sentCount = 0;
    symbolClients.forEach(client => {
      try {
        client.send(message);
        sentCount++;
      } catch (err) {
        // Log errors asynchronously to avoid blocking
        setImmediate(() => {
          console.error(`[${symbol}] Client send error: ${err.message}`);
        });
      }
    });

    // Update counters asynchronously
    if (!this._updateCounter) this._updateCounter = {};
    if (!this._updateCounter[symbol]) this._updateCounter[symbol] = 0;
    this._updateCounter[symbol]++;
    
    // More frequent logging to see if updates are flowing
    if (this._updateCounter[symbol] % 100 === 0) {
      console.log(`[${symbol}] ${this._updateCounter[symbol]} depth updates sent to ${sentCount}/${symbolClients.length} clients`);
    }
  }

  /**
   * Broadcast resync message to clients after order book reset  
   * @param {string} symbol
   */
  _broadcastResync(symbol) {
    const symbolClients = Array.from(this.localWSS.clients).filter(
      client => client.symbol === symbol && client.readyState === WebSocket.OPEN
    );

    if (symbolClients.length === 0) return;

    const message = JSON.stringify({ 
      type: 'resync',
      snapshot: this.orderBooks[symbol], 
      ts: Date.now() 
    });
    
    symbolClients.forEach(client => {
      try {
        client.send(message);
      } catch (err) {
        setImmediate(() => {
          console.error(`[${symbol}] Failed to send resync to client: ${err.message}`);
        });
      }
    });
  }

  /**
   * Send full order book snapshot to a specific client (used for new connections)
   * @param {WebSocket} client
   * @param {string} symbol
   */
  _sendSnapshotToClient(client, symbol) {
    if (!this.orderBooks[symbol] || client.readyState !== WebSocket.OPEN) return;

    try {
      const message = JSON.stringify({ 
        type: 'live_snapshot',
        snapshot: this.orderBooks[symbol],
        message: 'Current live order book snapshot. Real-time updates will follow immediately.',
        ts: Date.now() 
      });
      client.send(message);
    } catch (err) {
      setImmediate(() => {
        console.error(`[${symbol}] Failed to send snapshot to new client: ${err.message}`);
      });
    }
  }

  /**
   * Legacy broadcast method - REMOVED - was causing performance issues
   * Kept for compatibility but does nothing
   */
  _broadcastCurrentOrderBook(symbol) {
    // This method intentionally removed - periodic syncs were hurting performance
    // Clients now get updates immediately when data changes, no periodic sync needed
  }

  /**
   * Legacy broadcast method - kept for compatibility
   * @param {string} symbol
   * @param {string} msg
   */
  _broadcast(symbol, msg) {
    // Parse the message to add type indicator for live updates
    let broadcastMsg;
    try {
      const parsed = JSON.parse(msg);
      broadcastMsg = JSON.stringify({
        type: 'live_update',
        data: parsed,
        ts: Date.now()
      });
    } catch (err) {
      broadcastMsg = msg; // Fallback to original message
    }

    this.localWSS.clients.forEach(client => {
      if (client.symbol === symbol && client.readyState === WebSocket.OPEN) {
        client.send(broadcastMsg);
      }
    });
  }

  /**
   * Get connection statistics for debugging
   */
  getConnectionStats() {
    const stats = {};
    this.symbols.forEach(symbol => {
      const clients = Array.from(this.localWSS.clients).filter(c => c.symbol === symbol);
      const activeClients = clients.filter(c => c.readyState === WebSocket.OPEN);
      stats[symbol] = {
        totalClients: clients.length,
        activeClients: activeClients.length,
        hasOrderBook: !!this.orderBooks[symbol],
        lastUpdateId: this.orderBooks[symbol]?.lastUpdateId || 'N/A',
        binanceConnected: !!this.binanceWS[symbol] && this.binanceWS[symbol].readyState === WebSocket.OPEN
      };
    });
    return stats;
  }

  /**
   * Gracefully stop the service
   */
  async stop() {
    console.log('Stopping BinanceCOB service...');
    
    try {
      this.isRunning = false;

      // Stop snapshot timer
      if (this.snapshotTimer) {
        clearInterval(this.snapshotTimer);
        this.snapshotTimer = null;
      }

      // No periodic sync timer to stop - we removed it for performance

      // Commit any remaining historical data
      this.symbols.forEach(symbol => {
        if (this.historicalData[symbol] && this.historicalData[symbol].length > 0) {
          this._commitHistoricalDataAsync(symbol);
        }
      });

      // Close all Binance WebSocket connections
      Object.keys(this.binanceWS).forEach(symbol => {
        if (this.binanceWS[symbol]) {
          this.binanceWS[symbol].close();
          delete this.binanceWS[symbol];
        }
      });

      // Close all client connections
      this.localWSS.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.close();
        }
      });

      // Close the local WebSocket server
      await new Promise((resolve, reject) => {
        this.localWSS.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      console.log('BinanceCOB service stopped successfully');
    } catch (error) {
      console.error('Error stopping BinanceCOB service:', error.message);
      throw error;
    }
  }
}

module.exports = BinanceCOB;
