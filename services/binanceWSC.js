// binanceWSconcentrator.js

const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { logInfo, logWarn, logError } = require('./logger');

const LOCAL_WS_PORT = 8080;

const WS_BASE_URL = 'wss://stream.binance.com:9443/'; // Base for all WebSocket services

const DATA_DIR = path.join(__dirname, 'jsons');



// Preconfigured symbol pairs
    const SYMBOLS = [      
      'BTCUSDT',
      'ETHUSDT',
      'XRPUSDT',
    ];


if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

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
 * Aggregates an array of 1-second candle objects into 1-minute candles.
 * Assumes each candle has the standard Binance kline structure inside its "k" property.
 */
function aggregateToOneMinute(candles) {
  const groups = {};
  candles.forEach(candle => {
    const openTime = candle.k.t;
    const minute = Math.floor(openTime / 60000) * 60000;
    if (!groups[minute]) groups[minute] = [];
    groups[minute].push(candle.k);
  });

  return Object.keys(groups)
    .sort((a, b) => a - b)
    .map(minute => {
      const group = groups[minute];
      const openCandle = group[0];
      const closeCandle = group[group.length - 1];
      const aggregatedKline = {
        t: Number(minute),
        T: closeCandle.T,
        s: openCandle.s,
        i: '1m',
        f: openCandle.f || 0,
        L: closeCandle.L || 0,
        o: openCandle.o,
        c: closeCandle.c,
        h: Math.max(...group.map(c => c.h)),
        l: Math.min(...group.map(c => c.l)),
        v: group.reduce((sum, c) => sum + c.v, 0),
        n: group.reduce((sum, c) => sum + (c.n || 0), 0),
        x: closeCandle.x,
        q: group.reduce((sum, c) => sum + parseFloat(c.q || 0), 0),
        V: group.reduce((sum, c) => sum + parseFloat(c.V || 0), 0),
        Q: group.reduce((sum, c) => sum + parseFloat(c.Q || 0), 0),
        B: ''
      };

      return {
        e: 'kline',
        E: Date.now(),
        s: openCandle.s,
        k: aggregatedKline
      };
    });
}

class BinanceWebSocketConcentrator {
  constructor(symbols) {
    this.symbols = symbols;
    // No in-memory storage of candles
    this.clients = new Map();
    this.binanceWS = {};
    this.isPaused = false; // flag to control pausing the stream

    // Setup local WebSocket server for plugin clients
    this.localWSS = new WebSocket.Server({ port: LOCAL_WS_PORT });
    this.localWSS.on('connection', (ws, req) => this.handlePluginConnection(ws, req));

    // Remove rotation and commit intervals
    // this.commitInterval = setInterval(() => {
    //   this.symbols.forEach(symbol => this.commitRawData(symbol));
    // }, 4 * 60 * 60 * 1000);

    // this.dailyRotationInterval = setInterval(() => {
    //   this.handleDailyRotation();
    // }, 60 * 1000);

    // this.connectionRotationInterval = setInterval(() => {
    //   this.symbols.forEach(symbol => {
    //     if (this.binanceWS[symbol]) {
    //       logInfo(`[${symbol}] Committing data before connection rotate.`);
    //       this.commitRawData(symbol);
    //       logInfo(`[${symbol}] Rotating Binance WS connection.`);
    //       this.binanceWS[symbol].close();
    //     }
    //   });
    // }, 4 * 60 * 60 * 1000);

    this.initializeService();
  }

  async initializeService() {
    // Load files and connect to Binance WS.
    for (const symbol of this.symbols) {
      await this.loadOrInitializeFiles(symbol);
      this.initializeWebSocketForSymbol(symbol);
    }
  }

  async loadOrInitializeFiles(symbol) {
    const indexPath = path.join(DATA_DIR, `${symbol.toLowerCase()}-index.json`);
    const klineFilePath = path.join(DATA_DIR, `${symbol.toLowerCase()}-kline.json`);
    
    if (fs.existsSync(indexPath)) {
      try {
        const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        logInfo(`[${symbol}] Loaded index file.`);
      } catch (err) {
        logError(`[${symbol}] Failed to load index file: ${err.message}`);
      }
    } else {
      fs.writeFile(indexPath, JSON.stringify({ latestMinute: null }, null, 2), (err) => {
        if (err) {
          logError(`[${symbol}] Error creating index file: ${err.message}`);
        } else {
          logInfo(`[${symbol}] Created new index file.`);
        }
      });
    }

    if (!fs.existsSync(klineFilePath)) {
      fs.writeFile(klineFilePath, JSON.stringify([]), (err) => {
        if (err) {
          logError(`[${symbol}] Error creating kline file: ${err.message}`);
        } else {
          logInfo(`[${symbol}] Created kline file @ ${formatUKDate(new Date())}.`);
        }
      });
    }
  }
  
  /**
   * Retrieve historical data for a given symbol over a requested duration (in minutes).
   * This function reads the current day file from disk, filters, aggregates, and returns the result.
   */
  getHistoricalData(symbol, limit) {
    const today = formatUKDate(new Date());
    const filePath = path.join(DATA_DIR, `${symbol.toLowerCase()}-kline.json`);
    let diskData = [];
    
    if (fs.existsSync(filePath))
      {
        logInfo(`[${symbol}] Disk file ${filePath} found.`);
      try {
        diskData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!Array.isArray(diskData)) {
          logWarn(`[${symbol}] Disk file ${filePath} does not contain an array. Ignoring disk data.`);
          diskData = [];
        }
      } catch (err) {
        logError(`[${symbol}] Error reading disk data: ${err.message}`);
        diskData = [];
      }
    } else {
      logWarn(`[${symbol}] Disk file ${filePath} not found.`);
    }

    const now = Date.now();
    const startTime = now - limit * 60 * 1000;
    const filteredDiskData = diskData.filter(item => item.k && item.k.t >= startTime);
    const aggregated = aggregateToOneMinute(filteredDiskData);
    console.log(`[${symbol}] Returning ${aggregated.length} minutes of historical data.`);
    console.log(aggregated[0]);
    console.log(aggregated[aggregated
      .length - 1]);  
    console.log(aggregated[aggregated.length - 1].k.t - aggregated[0].k.t);
    console.log(aggregated[aggregated.length - 1].k.t - aggregated[0].k.t === limit * 60000);
    console.log(aggregated[aggregated.length - 1].k.t - aggregated[0].k.t === limit * 60000 ? 'Duration matches.' : 'Duration mismatch.');
    
    return aggregated;
  }


// Live candle and ticker events are now broadcast, not stored to disk.
initializeWebSocketForSymbol(symbol) {
  if (this.binanceWS[symbol]) {
    logInfo(`[${symbol}] Binance WS already connected.`);
    return;
  }
  if (this.isPaused) return; // Do not connect if paused

  const combinedWS = `${WS_BASE_URL}stream?streams=${symbol.toLowerCase()}@kline_1m/${symbol.toLowerCase()}@ticker`;

  logInfo(`[${symbol}] Connecting to Binance combined WS at ${combinedWS}...`);
  const ws = new WebSocket(combinedWS);
  ws.isAlive = true;

  ws.on('pong', () => { 
    ws.isAlive = true; 
  });

  ws.on('open', () => {
    logInfo(`[${symbol}] Connected to Binance combined WS.`);
    ws.hasReceivedMessage = false;
    ws.messageTimeout = setTimeout(() => {
      if (!ws.hasReceivedMessage) {
        logError(`[${symbol}] No data received within 10 seconds after reconnect. Closing connection.`);
        ws.close();
      }
    }, 10000);

    ws.pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.isAlive = false;
        ws.ping();
        setTimeout(() => {
          if (!ws.isAlive) {
            logWarn(`[${symbol}] No pong received. Terminating connection.`);
            ws.terminate();
          }
        }, 30000);
      }
    }, 30000);
  });

  ws.on('message', (message) => {
    if (!ws.hasReceivedMessage) {
      ws.hasReceivedMessage = true;
      clearTimeout(ws.messageTimeout);
    }

    try {
      const parsed = JSON.parse(message);
      const data = parsed.data;

      if (!data || !data.e) return;

      if (data.e === 'kline' && data.k.i === '1m') {
        // Broadcast 1-minute kline
        this.broadcastToClientsForSymbol(symbol, JSON.stringify(data));
      } else if (data.e === '24hrTicker') {
        // Broadcast 24hr ticker
        //logInfo(`[${symbol}] Received 24hr ticker data: ${JSON.stringify(data)}`);
       // this.broadcastToClientsForSymbol(symbol, JSON.stringify(data));
      }

    } catch (err) {
      logError(`[${symbol}] Error processing WS message: ${err.message}`);
    }
  });

  ws.on('close', () => {
    logWarn(`[${symbol}] Binance WS closed. Reconnecting in 5 seconds...`);
    if (ws.pingInterval) clearInterval(ws.pingInterval);
    delete this.binanceWS[symbol];
    setTimeout(() => this.initializeWebSocketForSymbol(symbol), 5000);
  });

  ws.on('error', (error) => {
    logError(`[${symbol}] Binance WS error: ${error.message}`);
    ws.terminate();
  });

  this.binanceWS[symbol] = ws;
}

  
  broadcastToClientsForSymbol(symbol, message) {
    for (const [client, subscription] of this.clients.entries()) {
      //logInfo(`[Plugin] Client subscription: ${JSON.stringify(subscription)}`);
      if (subscription.symbol && subscription.symbol.toUpperCase() === symbol.toUpperCase() &&
          client.readyState === WebSocket.OPEN) {
        try {
          if (subscription.masquerade) {
            let masqueraded;
            try {
              masqueraded = JSON.parse(message);
              masqueraded.s = 'XRPLUSD';
              if (masqueraded.k && masqueraded.k.s) masqueraded.k.s = 'XRPLUSD';
              client.send(JSON.stringify(masqueraded));
            } catch (e) {
              logError(`[Plugin] Failed to masquerade message: ${e.message}`);
              client.send(message);
            }
          } else {
            client.send(message);
          }
        } catch (err) {
          logError(`[Plugin] Failed to send live message: ${err.message}`);
        }
      }
    }
  }

  /**
   * commitRawData and handleDailyRotation remain for future use.
   */
  // Remove commitRawData and handleDailyRotation methods
  // commitRawData(symbol) {
  //   const today = formatUKDate(new Date());
  //   const filePath = path.join(DATA_DIR, `${symbol.toLowerCase()}-${today}.json`);
  //   let existingData = [];

  //   if (fs.existsSync(filePath)) {
  //     try {
  //       existingData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  //       if (!Array.isArray(existingData)) {
  //         logWarn(`[${symbol}] Daily file ${filePath} does not contain an array. Reinitializing.`);
  //         existingData = [];
  //       }
  //     } catch (err) {
  //       logError(`[${symbol}] Failed to parse existing JSON: ${err.message}`);
  //       return;
  //     }
  //   }
  //   logInfo(`[${symbol}] Commit: no new data to commit.`);
  // }

  // handleDailyRotation() {
  //   const now = new Date();
  //   const ukDate = now.toLocaleDateString('en-GB').replace(/\//g, '-');
  //   this.symbols.forEach(symbol => {
  //     const expectedFile = path.join(DATA_DIR, `${symbol.toLowerCase()}-${ukDate}.json`);
  //     if (!fs.existsSync(expectedFile)) {
  //       this.commitRawData(symbol);
  //       fs.writeFile(expectedFile, JSON.stringify([]), (err) => {
  //         if (err) {
  //           logError(`[${symbol}] Error creating new daily file during rotation: ${err.message}`);
  //         } else {
  //           logInfo(`[${symbol}] Daily rotation: started new file for ${ukDate}`);
  //         }
  //       });
  //     }
  //   });
  // }

  handlePluginConnection(ws, req) {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    
    logInfo(`[Plugin] New connection request from ${req.headers.host}.`);
    logInfo(`[Plugin] Request URL: ${reqUrl.href}`);
  
    // Extract the query parameters easily using URLSearchParams
    let symbol = reqUrl.searchParams.get('symbol');
    const interval = reqUrl.searchParams.get('interval');
    const limit = reqUrl.searchParams.get('limit');

    // XRPLUSD masquerade logic
    let masquerade = false;
    if (symbol && symbol.toUpperCase() === 'XRPLUSD') {
      masquerade = true;
      symbol = 'XRPUSDT';
      logInfo(`[Plugin] Masquerading XRPUSDT as XRPLUSD for client.`);
    }

    logInfo(`[Plugin] Client connected with symbol: ${symbol}, ${interval} Klines & ${limit} limit.`);

    this.clients.set(ws, { symbol, interval, limit, masquerade });

    logInfo(`[Plugin] ws Set and New connection established.`);
    if (limit) {
      const historicalData = this.getHistoricalData(symbol.toUpperCase(), parseInt(limit, 10));
      logInfo(`[Plugin] Sending historical data to client for symbol: ${symbol}, limit: ${limit}.`);
      historicalData.forEach(line => {
        if (masquerade) {
          let masqueraded = JSON.parse(JSON.stringify(line));
          masqueraded.s = 'XRPLUSD';
          if (masqueraded.k && masqueraded.k.s) masqueraded.k.s = 'XRPLUSD';
          ws.send(JSON.stringify(masqueraded));
        } else {
          ws.send(JSON.stringify(line));
        }
      });
    }
    // Pause for 1 second before handing over to live feed
    setTimeout(() => {
      logInfo(`[Plugin] Handing over to live feed for symbol: ${symbol} after 3 second pause.`);
    }, 3000);
    ws.on('close', () => {
      this.clients.delete(ws);
      logInfo(`[Plugin] Client disconnected.`);
    });
  }

  
  // Methods to control the live stream

  pauseStream() {
    logInfo('Pausing stream: closing all Binance WS connections.');
    this.isPaused = true;
    Object.keys(this.binanceWS).forEach(symbol => {
      if (this.binanceWS[symbol]) {
        this.binanceWS[symbol].close();
      }
    });
  }

  resumeStream() {
    logInfo('Resuming stream: reconnecting to Binance WS.');
    this.isPaused = false;
    this.symbols.forEach(symbol => {
      if (!this.binanceWS[symbol]) {
        this.initializeWebSocketForSymbol(symbol);
      }
    });
  }

 /* gracefulShutdown() {
    logInfo('Initiating graceful shutdown.');
    Object.keys(this.binanceWS).forEach(symbol => {
      if (this.binanceWS[symbol]) {
        this.binanceWS[symbol].close();
      }
    });
    this.localWSS.close(() => {
      logInfo('Local plugin WebSocket server closed.');
      process.exit(0);
    });
  } */
}

// CLI and signal handling.
const command = process.argv[2] ? process.argv[2].toLowerCase() : 'start';
const concentrator = new BinanceWebSocketConcentrator(SYMBOLS);

switch (command) {
  case 'pause':
    concentrator.pauseStream();
    break;
  case 'resume':
    concentrator.resumeStream();
    break;
  case 'exit':
    concentrator.gracefulShutdown();
    break;
  case 'start':
  default:
    logInfo('Starting live stream.');
    break;
}

//process.on('SIGINT', () => concentrator.gracefulShutdown());
//process.on('SIGTERM', () => concentrator.gracefulShutdown());
process.on('uncaughtException', (err) => {
  logError(`Uncaught exception: ${err.message}`);
 // concentrator.gracefulShutdown();
});
process.on('unhandledRejection', (reason) => {
  logError(`Unhandled rejection: ${reason}`);
  //concentrator.gracefulShutdown();
});
