const WebSocket = require('ws');
const WebSocketClient = require('../../../includes/WebSocketClient');
const createPluginLogger = require('./pluginsLogger');
// Initialize logger for ProfitLossPlugin
const { logInfo, logWarn, logError } = createPluginLogger('ProfitLossPlugin') || require('../logger');

const path = require('path');
const util = require('util');

const connectDB           = require('../../../includes/db')
const ExecutionReports = require('../../../models/ExecutionReports'); // Adjust the path as needed
const PnlTrades = require('../../../models/pnlTrades');
const TradeRecyclingService = require('../../TradeRecyclingService');
const { log } = require('console');
const Decimal = require('decimal.js');
const { v8_0_0 } = require('pixi.js');
const { now } = require('mongoose');


class ProfitLossPlugin {

  static globalRealisedPnL   = 0;
  static globalUnrealisedPnL = 0;

  constructor(options = {}) {
    this.name = 'ProfitLossPlugin';
    this.ws = null;
    this.klineWS = options.klineWS || null;
    this.symbol = options.symbol || null;
    this.duration = options.duration || null;
    this.limit = options.limit || 180;
    this.symbols = new Set(options.symbols || []);

    this.ledgerAddress = options.ledgerAddress || 'r9YuvurJ4zsJuGy8BzuDPmGRC1bUMSGGFW';

    this.execReportURL = options.execReportURL || 'ws://192.168.0.91:8083';
    this.execWS = null;    this.wallets = {};
    this.pnlwallets = {};
    this.walletsOpeningBalance = {};
    this.priceList =[];
    this.latestPrices = {}; // Track latest prices for re-entry logic

    this.tradesData = [];
    this.closedtrades = [];

    this.broadcastClient = new WebSocketClient(options.broadcastClientWS || 'ws://localhost:8083');
    this.broadcastClient.on('open', () => { logInfo('Connected to broadcast server on port 8083.'); });
    this.broadcastClient.on('error', (error) => logError('WebSocket error:', error));
    this.broadcastClient.on('close', () => logWarn('WebSocket closed.'));

    // Thresholds
    this.config = {
      profitperTrade:  options.profitperTrade || 500, // 500 USDT profit per trade
      profitPct:       options.profitThreshold       || 0.011,  // 1.1% default
      lossPct:         options.lossThreshold         || 0.0125, // 1.25% default
      killPct:         Math.abs(options.killSwitchThreshold || 0),
      trailPct:        options.trailingStopThreshold || 0.0005,  // 0.05% default
      realisedTP:      options.realisedTP            || 0.011,  // 1.1% default
      makerFeePct:     options.makerFeePct           || 0,
      takerFeePct:     options.takerFeePct           || 0,
      bnbDiscountPct:  options.bnbDiscountPct        || 0,
      tradeProtection: options.tradeProtection       || false
    };

    // Persistence
    this.persistenceFile = path.join(__dirname, '../jsons/trades.json');
    this.persistTrades = options.persistTrades || true;
    this.tradesDB = true; // Use a database for trades
    this.tradeRececlingEnabled = options.tradeRecyclingEnabled || true;
    this.trades = {};
    this.buyWalls = [];
    this.sellWalls = [];
    this.realisedPnL = 0;
    this.stopProfitEnabled = false;

    this.tradeRecyclingService = null; // Initialize trade recycling service

   //this.loadPersistence();
  }
  // Fetch XRP balance from the ledger using the configured ledgerAddress
  getPortfolioLedger() {
    const address = this.ledgerAddress;
    return fetch(`http://localhost:3000/api/ledger/balance/${address}`)
      .then(response => {
        if (!response.ok) throw new Error(`Failed to fetch XRP ledger balance. HTTP ${response.status}`);
        return response.json();
      })
      .then(balanceInfo => {
        // Store the XRPL balance in wallets as { asset, free, locked }
        this.wallets['XRPL'] = {
          asset: 'XRPL',
          free: parseFloat(balanceInfo.balance || 0),
          locked: 0
        };
        console.log(`${this.name} XRPL Wallet initialized from Ledger: ${address} Free: ${balanceInfo.balance} XRP`);
        return balanceInfo;
      })
      .catch(err => {
        console.error(`${this.name} Error initializing XRPL wallet from Ledger: ${err.message}`);
      });
  }

  getPortfolioBinance() {
    
    return fetch('http://localhost:3000/api/binance/balances')
      .then(response => {
        if (!response.ok) throw new Error(`Failed to fetch balances. HTTP ${response.status}`);
        return response.json();
      })
      .then(balanceArray => {
        // initialize walletsOpeningBalance if needed
        this.walletsOpeningBalance = this.walletsOpeningBalance || {};
        for (const { asset, free, locked } of balanceArray) {
          const freeAmount = parseFloat(free || 0);
          const lockedAmount = parseFloat(locked || 0);
          this.wallets[asset] = { asset, free: freeAmount, locked: lockedAmount };
          this.walletsOpeningBalance[asset] = { asset, free: freeAmount, locked: lockedAmount };
        }
        console.log(`${this.name} Wallets initialized from Binance: ${Object.keys(this.wallets).join(', ')}`);
      })
      .catch(err => {
        console.error(`${this.name} Error initializing wallets from Binance: ${err.message}`);
      });
  }

  // New function to update wallets by calling getPortfolioBinance
// ...existing code...

async updateWallets() {
  try {
    await this.getPortfolioBinance();
    // Only update XRPL from ledger
    const ledgerResult = await this.getPortfolioLedger();
    if (ledgerResult && typeof ledgerResult.balance !== 'undefined') {
      this.ledgerBalance = ledgerResult.balance;
    } else {
      this.ledgerBalance = null;
      // If ledger failed, ensure XRPL wallet is still present but null
      this.wallets['XRPL'] = {
        asset: 'XRPL',
        free: null,
        locked: 0
      };
    }
    console.log(`[${this.name}] Wallets updated:`, this.wallets);
    return this.wallets;
  } catch (err) {
    console.error(`[${this.name}] Error updating wallets: ${err.message}`);
  }
}

updateWalletPrices() {
  // Iterate over each asset in the wallet
  Object.keys(this.wallets).forEach(asset => {
    // Find a priceList entry whose base asset matches the wallet asset
    const priceEntry = this.priceList.find(entry => {
      const { base } = this.getBaseQuotePair(String(entry.symbol).toUpperCase());
      return base === asset.toUpperCase();
    });
    // Set the wallet price if a matching entry is found, otherwise null
    this.wallets[asset].price = priceEntry ? priceEntry.price : null;
  });
}


// New helper to extract base and quote assets from a symbol.
getBaseQuotePair(symbol) {
  const quoteSuffixes = ['AXL', 'ADA','ARB', 'USDT','FDUSD', 'ZRO','BTC','ETH','BUSD','USDC','BNB','TUSD','SOL','LTC','XRP','ZAR','DOGE','SHIB','LINK', 'USD']
  for (const q of quoteSuffixes) {
    if (symbol.endsWith(q)) {
      const base = symbol.slice(0, -q.length);
      return { base, quote: q };
    }
  }
  return { base: symbol, quote: '' };
}

// New method to update the pnlwallets based on base-to-quote pair prices.
updatePnLWallets() {
  // Build a map of pair prices using only valid base/quote pairs.
  const pairPrices = {};
  for (const { symbol, price } of this.priceList) {
    // Extract base and quote using the helper (both in uppercase)
    const { base, quote } = this.getBaseQuotePair(String(symbol).toUpperCase());
   
    //console.log(`Update PNL Wallets --> Base: ${base}, Quote: ${quote}`);

    if (!base || !quote) continue; // Skip if the symbol doesn't match a valid pair structure.
    if (!pairPrices[base]) {
      pairPrices[base] = {};
    }
    // Ensure price is a number rounded to 8 decimal places.
    pairPrices[base][quote] = parseFloat(parseFloat(price).toFixed(8));
  }

  // Build sets for all unique assets from both base and quote.
  const assetSet = new Set();
  for (const base in pairPrices) {
    // Add the base asset to the set
    assetSet.add(base);
    for (const quote in pairPrices[base]) {
      
      assetSet.add(quote);
      //console.log(`assetSet --> ${Array.from(assetSet).join(', ')}`);
    }
  }

  // Create a conversion matrix: rows and columns are all assets from assetSet.
  const matrix = {};
  for (const base of assetSet) {
    matrix[base] = {};
    for (const quote of assetSet) {
      let value;
      if (base === quote) {
        value = 1;
      } else if (pairPrices[base] && pairPrices[base][quote] !== undefined) {
        value = pairPrices[base][quote];
      } else if (pairPrices[quote] && pairPrices[quote][base] !== undefined && pairPrices[quote][base] != 0) {
        value = 1 / pairPrices[quote][base];
      } else {
        value = null;
      }
      if (value !== null) {
        value = parseFloat(value.toFixed(8));
      }
      matrix[base][quote] = value;
    }
  }

  this.pnlwallets = matrix;
  //console.log(`[${this.name}] Updated conversion matrix:`, this.pnlwallets);
}

  async init() {
    await connectDB();
    logInfo(`[${this.name}] Connected to DB.`);
    
    this.updateWallets();

    //Trade Recycling Service
    if (this.tradeRececlingEnabled) {
      this.tradeRecyclingService = new TradeRecyclingService();
      this.tradeRecyclingService.onQualified((candidate) => {
        logInfo(`[${this.name}] ♻️ CALLBACK: Trade re-entry candidate qualified!`);
        
        // Extract candidate details
        const { originalTrade, reentryPrice, reason } = candidate;
        const symbol = originalTrade ? originalTrade.symbol : 'Unknown';
        
        // ♻️ CREATE RE-ENTRY BUY SIGNAL
        if (originalTrade && originalTrade.symbol && originalTrade.quantity) {
          const currentPrice = this.latestPrices && this.latestPrices[symbol] ? this.latestPrices[symbol] : reentryPrice;
            const reentrySignal = {
            plugin: this.name,
            clientOrderId: 'Recycle_' + originalTrade.clientOrderId,
            symbol: symbol,
            price: currentPrice,
            action: 'BUY',
            side: 'BUY',
            orderType: 'MARKET',
            quantity: originalTrade.quantity,
            entryPrice: currentPrice.toFixed(3),
            currentPrice: currentPrice.toFixed(3),
            recycledFrom: originalTrade.clientOrderId,
            recycleReason: reason,
            timestamp: new Date().toISOString()
            };

          logInfo(`[${this.name}] ♻️ Broadcasting RE-ENTRY BUY signal for ${symbol} @ ${currentPrice.toFixed(3)}`);
          this.broadcastSignal(reentrySignal);
          
        } else {
            logWarn(`[${this.name}] ♻️ Cannot create re-entry signal: missing originalTrade data or trade recycling is disabled.`);
          }
          
        
        logInfo(`[${this.name}] ✅ Trade recycling callback registered successfully`);
        this.tradeRecyclingService.monitor();

        // Test if callback is properly set
        setTimeout(() => {
          logInfo(`[${this.name}] 🔍 Callback check: ${!!this.tradeRecyclingService.onQualifiedCandidate}`);
          console.table(this.tradeRecyclingService.getQualifiedCandidates());
        }, 5000);
      });
    }


      // Refresh Binance balances every 60 seconds
      setInterval(() => {
        this.updateWallets();
      }, 60000);

      // Rebuild PnL matrix + broadcast every 2 seconds
      setInterval(() => {
        this.updatePnLWallets();
        //this.updateWallets();
        this.aggregatePnLAndBroadcast();
        this.updateWalletPrices();
      }, 2000);
  }
  



popTrade(clientOrderId) {
  // Ensure the trade exists and keep its reference before deletion
  const tradeToProcess = this.trades[clientOrderId];
  if (tradeToProcess) {
    delete this.trades[clientOrderId];
    logInfo(`[${this.name}] Trade ${clientOrderId} deleted successfully from trades.`);
  } else {
    logWarn(`[${this.name}] Trade ${clientOrderId} not found. No deletion performed.`);
    return;
  }
  

  
  logInfo(`[${this.name}] Removed trade ${clientOrderId} from persistence.`);
  
  // ♻️ Send profitable trade to recycling service
  const pnl = parseFloat(tradeToProcess.realisedPnLNet || 0);
  if (pnl > 0 && this.tradeRececlingEnabled && this.tradeRecyclingService) {
    this.tradeRecyclingService.addCandidate(tradeToProcess);
    logInfo(`[${this.name}] ♻️ Trade ${clientOrderId} sent to recycling service (PnL $${pnl.toFixed(2)}).`);
  }
  
  // Save persistence after closing the trade
  //this.savePersistence();
}


  loadPersistence() {
    try {
      logInfo('[ProfitLossPlugin] loadPersistence called.'); // Log entry point

      // Load persistence from the database using the pnlTrades model.
      PnlTrades.find({}).lean()
        .then(data => {
          if (data && data.length > 0) {
            this.trades = {};
            let totalRealised = 0;
            data.forEach(trade => {
              this.trades[trade.clientOrderId] = trade;
              totalRealised += parseFloat(trade.realisedPnLNet || 0);
            });
            this.realisedPnL = totalRealised;
            logInfo('[ProfitLossPlugin] Loaded persistence from database.');

            for (const t of Object.values(this.trades)) {
              if (t.status === 'OPEN') {
                t.profitPrice = new Decimal(t.entryPrice).mul(new Decimal(1).add(this.config.profitPct)).toNumber();
                t.stopLossPrice = new Decimal(t.entryPrice).mul(new Decimal(1).sub(this.config.lossPct)).toNumber();
                t.trailingStopPrice = new Decimal(t.highestPrice || t.entryPrice).mul(new Decimal(1).sub(this.config.trailPct)).toNumber();
                t.killSwitchPrice = new Decimal(t.entryPrice).mul(new Decimal(1).sub(this.config.killPct)).toNumber();
                t.highestPrice = t.highestPrice || t.entryPrice;
                t.fillComission = t.fillComission ?? 0;
                t.unrealisedPnLGross = t.unrealisedPnLGross ?? '0.00';
                t.unrealisedPnLNet = t.unrealisedPnLNet ?? '0.00';
              }
            }
            logInfo('[ProfitLossPlugin] Recalculated thresholds on load if missing.');
          } else {
            logWarn('[ProfitLossPlugin] No persistence data found in database.');
          }
        })
        .catch(err => {
          logError('[ProfitLossPlugin] Error loading persistence from database:', err);
        });
    } catch (err) {
      logError('[ProfitLossPlugin] Error loading persistence:', err);
    }
  }

  async savePersistence(clientOrderId, updatedFields) {
    if (!this.persistTrades) {
      logInfo('[ProfitLossPlugin] Persistence saving is disabled.');
      return;
    }

    // If clientOrderId and updatedFields are provided, update only that trade.
    if (clientOrderId && updatedFields) {
      try {
        await PnlTrades.updateOne(
          { clientOrderId },
          { $set: updatedFields },
          { upsert: true }
        );
        logInfo(`[ProfitLossPlugin] Updated persistence for clientOrderId: ${clientOrderId}.`);
      } catch (err) {
        logError('[ProfitLossPlugin] Error updating persistence for clientOrderId:', clientOrderId, err);
      }
      return;
    }

    // Otherwise, perform a bulk update for all trades.
    const tradesArray = Object.values(this.trades);
    const bulkOps = [];

    for (const trade of tradesArray) {
      try {
        // Retrieve the existing trade from the DB by clientOrderId.
        const existing = await PnlTrades.findOne({ clientOrderId: trade.clientOrderId }).lean();
        let updateFields = {};

        if (existing) {
          // Build an object with only the fields that differ.
          for (const [key, value] of Object.entries(trade)) {
            if (existing[key] !== value) {
              updateFields[key] = value;
            }
          }
        } else {
          // No existing document – upsert the entire trade.
          updateFields = trade;
        }

        if (Object.keys(updateFields).length > 0) {
          bulkOps.push({
            updateOne: {
              filter: { clientOrderId: trade.clientOrderId },
              update: { $set: updateFields },
              upsert: true
            }
          });
        }
      } catch (err) {
        logError('[ProfitLossPlugin] Error processing trade persistence for clientOrderId:', trade.clientOrderId, err);
      }
    }

    if (bulkOps.length > 0) {
      PnlTrades.bulkWrite(bulkOps)
        .then(() => {
          logInfo('[ProfitLossPlugin] Saved all trades persistence to database.');
        })
        .catch((err) => {
          logError('[ProfitLossPlugin] Error saving trades persistence to database:', err);
        });
    }
  }

 broadcastSignal(signalData) {
    // Guard: Do not broadcast if signalData is empty or all fields are blank/null/undefined
    if (!signalData || (typeof signalData === 'object' && Object.values(signalData).every(v => v === null || v === '' || v === undefined))) {
      logError(`[${this.name}] Attempted to broadcast an empty signal, skipping.`);
      return;
    }
    const message = {
      type: 'signal',
      ...signalData,
      data: Array.isArray(signalData.data) ? signalData.data[0] : signalData.data,
      timestamp: Date.now()
    };
    this.broadcastClient.send(message);
  }

  _initSocket(url, { onMessage}) {
    const ws = new WebSocket(url);
    ws.on('open',    () => logInfo(`[${this.name}] WS connected.`));
    ws.on('message', onMessage);
    ws.on('error',   (err) => logError(`[${this.name}] WS error:`, err));
    ws.on('close',   () => {
      logWarn(`[${this.name}] WS closed. Reconnecting in 5s…`);
      setTimeout(() => this._initSocket(url, { onMessage}), 5000);
    });
    return ws;
  }

  async initializeWebSocket() {
    if (!this.klineWS) {
      return logError(`[${this.name}] klineWS URL not provided.`);
    }
    this.symbolSockets = [];

    for (const symbol of this.symbols) {
      const url = `${this.klineWS}?symbol=${symbol}`;
      
      this.symbolSockets.push(this._initSocket(url, { onMessage: (msg) => this.processKlineMessage(msg) }));
      logInfo(`[${this.name}] Initialized WebSocket for symbol: ${symbol}`);
    }
  }

  processKlineMessage(raw) {
    let str;
    try {
      str = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
    } catch (e) {
      return logError(`[${this.name}] Failed to decode WS frame: ${e.message}`, raw);
    }
  
    let msg;
    try {
      msg = JSON.parse(str);
    } catch (_) {
      // Not JSON — heartbeats or pings — ignore
      return;
    }
  
    // If this is a kline event, always grab the latest close price
    if (msg.k && typeof msg.k.c !== 'undefined') {
      const symbol = msg.s ;
      const price = parseFloat(msg.k.c);
      const ts    = msg.k.t;

      if (!Array.isArray(this.priceList)) {
        this.priceList = [];
      }
      const index = this.priceList.findIndex(item => item.symbol === symbol);
      if (index !== -1) {
        // Update only the relevant symbol with the latest price and timestamp.
        this.priceList[index] = { ...this.priceList[index], price, ts };
      } else {
        // Add a new symbol entry.
        this.priceList.push({ symbol, price, ts });
      }   
      
      //logInfo(`[${this.name}] Processed kline for ${symbol}: price=${price}, ts=${new Date(ts).toISOString()}`);
      //console.log(`[${this.name}] Current price list:`, this.priceList);

      if (Number.isNaN(price)) {
        return logError(`[${this.name}] Invalid price in kline:`, msg.k.c);
      }
  
      // every single update, not just when x===true
      try {
        //console.log(`[${this.name}] Kline update: ${price} @ ${new Date(ts).toISOString()}`);
        this.processNewPriceData(symbol, price, ts);
      } catch (err) {
        logError(`[${this.name}] Error in processNewPriceData:`, err);
      }
    }
  }

  async loadExecReports() {

    const reports = await ExecutionReports.find({
      journalClientOrderId: { $ne: 'CLOSED' } // Exclude closed trades
    }).sort({ eventTime: 1 }).lean();

    const buyReports = reports.filter(report => report.side === 'BUY');

    // If trades exist, filter out any BUY reports that have already been processed.
    // This prevents reprocessing trades that have already been handled.
    /*
    if (this.trades && Object.keys(this.trades).length > 0) {
      const filtered = buyReports.filter(report => !this.trades.hasOwnProperty(report.clientOrderId));
      buyReports.length = 0;
      buyReports.push(...filtered);
    }
    */          

    
    const sellReports = reports.filter(report => report.side === 'SELL');

    for (const rpt of buyReports) {
      this.handleExecutionReport(rpt);

    }
    // Then process all SELL reports.
    for (const rpt of sellReports) {
      this.handleExecutionReport(rpt);
    }
    logInfo(`[${this.name}] Replayed ${reports.length} execution reports.`);
  }

  initializeExecReportSocket() {
    if (!this.execReportURL) return logError('[ProfitLossPlugin] execReportURL not provided.');

    this.execWS = this._initSocket(this.execReportURL, {
      onMessage: (msg) => this.processExecReportMessage(msg),
      
    });
  }


  async processExecReportMessage(raw) {
    let report;
    try {
      const str    = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
      report       = JSON.parse(str);
    } catch (err) {
      return logError('[ProfitLossPlugin] Invalid exec-report JSON:', err);
    }

    if (report.type === 'graphMessage') {
      if (report.buyWalls) {
        // Convert buyWalls object to array if needed
        if (!Array.isArray(report.buyWalls)) {
          this.buyWalls = Object.values(report.buyWalls);
        } else {
          this.buyWalls = report.buyWalls;
        }
      

      if (report.sellWalls) {
        // Convert sellWalls object to array if needed
        if (!Array.isArray(report.sellWalls)) {
          this.sellWalls = Object.values(report.sellWalls);
        } else {
          this.sellWalls = report.sellWalls;
        }
        return;
      }
    }
    }

       /* logInfo(`[${this.name}] BUY Walls:`);
      console.table(this.buyWalls.map(w => ({
        Symbol: w.symbol,
        Price: w.price,
        Volume: w.volume,
        Pct: w.percentage.toFixed(2),
        Dist: w.distance,
        '%Dist': w.pctDist.toFixed(4),
        Detected: new Date(w.detectedAt).toLocaleTimeString(),
        Updated: new Date(w.lastUpdated).toLocaleTimeString()
      })));
      }

        logInfo(`[${this.name}] SELL Walls:`);
         console.table(this.sellWalls.map(w => ({
        Symbol: w.symbol,  
        Price: w.price,
        Volume: w.volume,
        Pct: w.percentage.toFixed(2),
        Dist: w.distance,
        '%Dist': w.pctDist.toFixed(4),
        Detected: new Date(w.detectedAt).toLocaleTimeString(),
        Updated: new Date(w.lastUpdated).toLocaleTimeString()
      }))); */


    // ****** Handle trade updates from the trading dashboard ****
    if (report.type === 'fieldUpdate') {
      logInfo(`[${this.name}] Received field update report: ${JSON.stringify(report)}`);
      const { clientOrderId, updatedFields } = report.data;
      if (this.trades[clientOrderId]) {
        Object.assign(this.trades[clientOrderId], updatedFields);
        const showUpdatedFields = { ...this.trades[clientOrderId] };
        logInfo(`[${this.name}] ${JSON.stringify(showUpdatedFields)}`);
        logInfo(`[${this.name}] Trade ${clientOrderId} updated with fields: ${JSON.stringify(updatedFields)}`);
      // this.savePersistence(clientOrderId, updatedFields);
      } else {
        logWarn(`[${this.name}] No trade found with clientOrderId ${clientOrderId} to update.`);
      }
      return;
    }

    if (report.type === 'xrplReport') {
      logInfo(`[${this.name}] Received xrpl report: ${JSON.stringify(report)}`);
      const l = report.data;
      const rpt     = {
      ...l,
      eventTime:         new Date(l.eventTime),
      orderCreationTime: new Date(l.orderCreationTime),
      transactionTime:   new Date(l.transactionTime),
    };

      // XRPL "amount" is in drops (1 XRP = 1,000,000 drops)

      logInfo(`[${this.name}] Processed ledger activity for ${l.symbol}:`, l);
    try {
      this.handleExecutionReport(rpt);
      
    } catch (err) {
      logError('[ProfitLossPlugin] Error handling exec-report:', err);
    }
      return;
    }

    if (report.type === 'executionReport') {

    // normalize the shape & types to match your .lean() docs
    const d       = report.data;
    const rpt     = {
      ...d,
      eventTime:         new Date(d.eventTime),
      orderCreationTime: new Date(d.orderCreationTime),
      transactionTime:   new Date(d.transactionTime),
    };



    logInfo(`[${this.name}] Received execution report:`);
    console.table(Array.isArray(rpt) ? rpt : [rpt]);
  
    try {
      this.handleExecutionReport(rpt);
      
    } catch (err) {
      logError('[ProfitLossPlugin] Error handling exec-report:', err);
    }
  }
}

  handleExecutionReport(data) {
    // 0) Parse identifiers and numeric fields
    const clientOrderId               = data.clientOrderId;
    const journalClientOrderId = data.journalClientOrderId === 'Audit_Pending' ? data.clientOrderId : data.journalClientOrderId;
    const orderId          = data.orderId;
    const symbol           = data.symbol;
    const fillPrice        = parseFloat(data.lastFilledPrice);
    const fillQty          = parseFloat(data.accumulatedFilledQuantity); 
    const fillCommission   = parseFloat(data.commissionAmount) || 0;
    const isBuy            = data.side === 'BUY';
    const entryPrice = new Decimal(fillPrice);
    //const tradeStatus = data.clientOrderId.toLowerCase().includes('recycle' || 'abp') && fillQty < 500 ? 'TRADE' : 'OPEN';
    //const tradeStatus = clientOrderId.includes("x-JGG") ? 'TRADE' : 'OPEN';
    const tradeStatus = 'OPEN'; // Default to 'OPEN' for all trades

    const totalTradeValue = new Decimal(fillPrice).mul(new Decimal(fillQty));
    const takerFeeRate = new Decimal(0.0007); // 0.0700%
    const takerFee = totalTradeValue.mul(takerFeeRate);
    logInfo(`[${this.name}] Calculated taker fee of ${takerFee.toFixed(8)} for trade ${clientOrderId}.`);

    const graphSignal = {
      plugin: 'WHATEVER', // < ----- FIX THIS AT SOME POINT
      symbol,
      price: fillPrice,
      action: data.side,
      clientOrderId: clientOrderId,
      orderId,
      timestamp: data.eventTime.getTime()
    };

    //  logInfo(`[${this.name}] Broadcasting graph signal: ${JSON.stringify(graphSignal)}`);
      this.broadcastSignal(graphSignal);

    if (isBuy) {

      const entry = new Decimal(fillPrice);
      const lossFactor  = Decimal(1).minus(this.config.lossPct);
      const trailFactor = Decimal(1).minus(this.config.trailPct);
      const killFactor  = Decimal(1).minus(this.config.killPct);

      const baseTrade = {
        clientOrderId: clientOrderId,
        journalClientOrderId: journalClientOrderId,
        dateTime: new Date(data.eventTime).getTime(),  // timestamp for sorting
        orderId: data.orderId,
        symbol,
        side: 'BUY',
        entryPrice: entry.toNumber(),
        quantity: new Decimal(fillQty).toNumber(),
        highestPrice: entry.toNumber(),
        profitPrice:       entry.mul( Decimal(1).plus(this.config.profitPct) ).toNumber(),
        stopLossPrice:     entry.mul( lossFactor  ).toNumber(),
        trailingStopPrice: entry.mul( trailFactor ).toNumber(),
        killSwitchPrice:   entry.mul( killFactor  ).toNumber(),
        profitReached: false,
        realisedPnLGross: 0,
        realisedPnLNet: 0,
        unrealisedPnLGross: '0.00',
        unrealisedPnLNet: '0.00',
        fillComission: new Decimal(fillCommission).toNumber(),
        
        expectedProfit: entryPrice
          .mul(new Decimal(this.config.profitPct))
          .mul(new Decimal(fillQty))
          .toNumber()
          .toFixed(3),
        reason: 'Position Open',
        status: tradeStatus, // 'OPEN' or 'TRADE'
        stopProfit: new Decimal(0).toNumber(), // Default to 0, can be updated later
        stopProfitEnabled: this.stopProfitEnabled,
      };

      this.trades[clientOrderId] = baseTrade;
                  
      this.savePersistence();

      return;
    }

    // 2) Only SELL side reaches the close‐out logic
    if (data.side !== 'SELL') {
      return;
    }

    logInfo(`[${this.name}] Current trades:`);
    logInfo(`[${this.name}] SELL execution report for clientOrderId=${clientOrderId}`);
    logInfo(`[${this.name}] Execution report data: ${JSON.stringify(data, null, 2)}`);

    logInfo(`[${this.name}] Trade list before processing SELL:`);
    console.table(this.trades);

    

    // Find the original BUY trade that this SELL order is closing.
    // The SELL order's clientOrderId should match the BUY order's journalClientOrderId.
    const trade = Object.values(this.trades).find(t => {
    if (t.clientOrderId === journalClientOrderId) {
        t.matchType = 'HISTORICAL';
        return true;
    }
    if (t.journalClientOrderId === clientOrderId || t.clientOrderId === clientOrderId && t.clientOrderId.includes('TDB')) {
        //this should fire when the SELL is handled by the dashboard
        t.matchType = 'LIVE';
        ExecutionReports.updateOne(
          { clientOrderId: clientOrderId, side: 'SELL' },
          { $set: { journalClientOrderId: t.journalClientOrderId || t.clientOrderId } }
        ).catch(err => {
          logError(`[${this.name}] Error updating DB for clientOrderId: ${clientOrderId}:`, err);
        });
        return true;
    }
    // If no match is found, return false.
    return false;
});

if (trade) {
    console.log(`Trade found. Type: ${trade.matchType}`);
} else {
    console.log("No matching trade was found.");
    return logError(`[${this.name}] No matching trade found for SELL clientOrderId=${clientOrderId}.`);
}

    // Since a trade was found, we can proceed.
    console.table([trade]);

    //console.table(this.priceList);
    //return;

    //logInfo(`[${this.name}] Found trade for clientOrderId=${clientOrderId}. Updating executionreport journalClientOrderId with ${trade.journalClientOrderId} in executionreport table.`);


    logInfo(`[${this.name}] ---------------------------------------------------------> Begin Closing out trade for SELL clientOrderId=${clientOrderId} <---------------------------------------------------------`);

    console.log(`✚ [SELL] Closing lot ${clientOrderId}: qty=${fillQty}@${fillPrice}`);
    console.table([{
      clientOrderId: clientOrderId,
      journalClientOrderId: journalClientOrderId,
      orderId: orderId,
      symbol: symbol,
      side: 'SELL',
      fillQty: fillQty,
      fillPrice: fillPrice,
      $Value: fillQty * fillPrice,
      fillCommission: trade.fillCommission
    }]);

    const matchingTrades = [trade];
    console.table(matchingTrades);

    if (matchingTrades.length === 0) {
      logError(`[${this.name}] No open trade found for SELL clientOrderId ${clientOrderId}`);
      return;
    }

    logInfo(`[${this.name}]Closing out trades for SELL clientOrderId=${clientOrderId} with ${matchingTrades.length} matching trades.`);


    this.closeOutTrade({
      tradeList: matchingTrades,
      fillQty,
      fillPrice,
      fillCommission,
      orderId,
      clientOrderId: clientOrderId,
      eventTime: data.eventTime
    });
  }

  closeOutTrade({ tradeList, fillQty, fillPrice, fillCommission, clientOrderId, eventTime }) {
    let remainingQty = fillQty;
    const realisedTrades = [];
    let totalRealised = 0;

    logInfo(`[${this.name}] Starting closeOutTrade for SELL ID ${clientOrderId} with fillQty=${fillQty}, fillPrice=${fillPrice}, fillCommission=${fillCommission}`);
    
    // Log details of each trade in the list
    tradeList.forEach((buy, index) => {
      logInfo(`[${this.name}] Trade ${index + 1}/${tradeList.length} with clientOrderId=${buy.clientOrderId} and quantity=${buy.quantity}`);
    });

    for (const buy of tradeList) {
      if (remainingQty <= 0) {
        logInfo(`[${this.name}] No remaining quantity to close. Exiting loop.`);
        break;
      }

      const closingQty = Math.min(buy.quantity, remainingQty);
      // cost of opening
      const buyCost = buy.entryPrice * closingQty;
      // split the exit commission
      const proportionalExitCommission = fillCommission * (closingQty / fillQty);
      // include the entry commission too
      const fillComission = buy.fillComission || 0;
      const totalCommission = fillComission + proportionalExitCommission;

      // gross pnl ignores all fees
      const realisedPnLGross = fillPrice * closingQty - buyCost;
      // net pnl subtracts both entry + exit fees
      const realisedPnLNet = realisedPnLGross - totalCommission;

      const closedTrade = {
        ...buy,
        quantity: closingQty,
        exitPrice: fillPrice,
        exitCommission: proportionalExitCommission,
        totalCommission: totalCommission.toFixed(2),
        status: 'CLOSED',
        realisedPnLGross: realisedPnLGross.toFixed(2),
        realisedPnLNet: realisedPnLNet.toFixed(2),
        // …
      };

      console.table([closedTrade]);

      // Record closed trade and update global metrics
      realisedTrades.push(closedTrade);
      const pnl = parseFloat(closedTrade.realisedPnLNet || 0);
      totalRealised += pnl;
      ProfitLossPlugin.globalRealisedPnL += pnl;
      logInfo(`[${this.name}] Global realised PnL updated: $${ProfitLossPlugin.globalRealisedPnL.toFixed(2)}`);

      // Update remaining quantity for the close-out process
      remainingQty -= closingQty;
      logInfo(
        `[${this.name}] Closed ${closingQty} units from trade ${buy.clientOrderId}. Remaining quantity: ${remainingQty}`
      );

      // Add the closed trade to the list and log its details
      this.closedtrades.push(closedTrade);
      logInfo(`[${this.name}] Closed trade added:`);
      console.table([closedTrade]);

      // Remove the trade from active trades
      delete this.trades[closedTrade.clientOrderId];
      logInfo(`[${this.name}] Removed active trade with clientOrderId: ${closedTrade.clientOrderId}`);

      // Trade Recycling Service: Send trade as a candidate if it qualifies
      if (parseFloat(closedTrade.realisedPnLGross) > 100 && this.tradeRecyclingService) {
        this.tradeRecyclingService.addCandidate(closedTrade);
        logInfo(
        `[${this.name}] ♻️ Trade ${closedTrade.clientOrderId} sent to recycling service (PnL: $${pnl.toFixed(2)})`
        );
      }

      // Log the final summary for the close-out process
      logInfo(
        `[${this.name}] Closing process complete. Total realised PnL: $${totalRealised.toFixed(2)} from ${realisedTrades.length} trade(s).`
      );

      // Persist changes after closing out trades
      this.savePersistence();
    }
    }

processNewPriceData(symbol, currentPrice, timestamp) {
  const normalizedSymbol = String(symbol).trim().toUpperCase();

  // Update latest prices for re-entry logic
  this.latestPrices[normalizedSymbol] = currentPrice;

try {
  this.tradeRecyclingService.updatePrice(symbol, currentPrice);
  this.tradeRecyclingService.evaluate(normalizedSymbol, currentPrice);
} catch (err) {
  logError(`[${this.name}] ⚠️ Recycling evaluate() failed for ${normalizedSymbol}: ${err.stack || err.message || err}`);
}

  let combinedUnrealised = 0;

  for (const [clientOrderId, trade] of Object.entries(this.trades)) {
    
    if (!trade || (String(trade.status).toUpperCase() !== 'OPEN' && String(trade.status).toUpperCase() !== 'TRADE')) {
      continue;    }
  
    if (trade.symbol.toUpperCase() !== normalizedSymbol) continue;

    // Compute PnL
    const grossUnrealised = (currentPrice - trade.entryPrice) * trade.quantity;
    const netUnrealised = grossUnrealised - (trade.fillComission || 0);
    trade.unrealisedPnLGross = grossUnrealised.toFixed(2);
    trade.unrealisedPnLNet = netUnrealised.toFixed(2);
    trade.price = currentPrice;
    combinedUnrealised += netUnrealised;

    // Evaluate SELL logic
if (!this.trades) {
  logError(`[${this.name}] No trades found for symbol ${normalizedSymbol}.`);
  continue;
}

let evaluation;
if (this.config.tradeProtection) {
  evaluation = {
    action: 'HOLD',
    reason: 'Trade protection is enabled, skipping evaluation.',
  };
  //logInfo(`[${this.name}] Trade protection is enabled, skipping evaluation for - Trade:  ${clientOrderId}.`)
} else {
  evaluation = this.evaluateExitCondition(trade, currentPrice);
  //console.table(trade);
}
const { action, reason } = evaluation;
    

    // Build the signal
    if (action === 'SELL') {
      logInfo(`[${this.name}] Closing trade ${clientOrderId} (${trade.symbol}).`);

      let sellQuantity = trade.quantity; // Default to full quantity for stop-loss, etc.


      const signal = {
        plugin: this.name,
        clientOrderId: 'PnL_' + Date.now().toString(16) + '_' + Math.floor(Math.random() * 9999 + 1).toString(16),
        symbol: normalizedSymbol,
        price: currentPrice,
        action,
        side: action,
        orderType: 'MARKET',
        quantity: sellQuantity,
        entryPrice: trade.entryPrice.toFixed(3),
        currentPrice: currentPrice.toFixed(3),
        profitPrice: trade.profitPrice.toFixed(3),
        expectedProfit: ((trade.profitPrice - trade.entryPrice - (trade.fillComission || 0)) * trade.quantity).toFixed(3),
        stopLossPrice: trade.stopLossPrice.toFixed(3),
        trailingStopPrice: trade.trailingStopPrice.toFixed(3),
        killSwitchPrice: trade.killSwitchPrice.toFixed(3),
        highestPrice: trade.highestPrice.toFixed(3),
        unrealisedPnLGross: trade.unrealisedPnLGross,
        unrealisedPnLNet: trade.unrealisedPnLNet,
        fillComission: (trade.fillComission || 0).toFixed(8),
        totalCommission: (trade.fillComission || 0).toFixed(8),
        commissionAsset: trade.commissionAsset || 'UNKNOWN',
        reason,
        timestamp: new Date(timestamp).toISOString()
      };

      this.trades[journalClientOrderId] = signal.clientOrderId;
      // Update the trade status to AWAITING_CLOSE
      this.trades[clientOrderId].status = 'AWAITING_CLOSE';
      this.trades[clientOrderId].exitPrice = currentPrice;

      logInfo(`[${this.name}] Broadcasting SELL signal for ${trade.symbol} @ ${currentPrice.toFixed(3)} with ID ${signal.clientOrderId}`);
      logInfo(`[${this.name}] Signal details:`, signal);
      this.broadcastSignal(signal);
    }
  }

  return;
}

evaluateExitCondition(trade, currentPrice) {
  
  if (trade.status !== 'TRADE') {
    //console.log(`[${this.name}] Trade is not in TRADE status:`, trade);
    return {
      action: 'HOLD',
      reason: `Trade ${trade.symbol} is not in TRADE status.`
    };
  }

  logInfo(`[${this.name}] Evaluating exit condition for trade ${trade.symbol} at current price ${currentPrice.toFixed(3)}`);
  console.table([{
    entryPrice: trade.entryPrice.toFixed(3),
    profitPrice: trade.profitPrice.toFixed(3),
    stopLossPrice: trade.stopLossPrice.toFixed(3),
    trailingStopPrice: trade.trailingStopPrice.toFixed(3),
    killSwitchPrice: trade.killSwitchPrice.toFixed(3),
    highestPrice: trade.highestPrice.toFixed(3),
    unrealisedPnLGross: trade.unrealisedPnLGross,
    unrealisedPnLNet: trade.unrealisedPnLNet,
    fillComission: (trade.fillComission || 0).toFixed(8),
    totalCommission: (trade.fillComission || 0).toFixed(8),
    expectedProfit: ((trade.profitPrice - trade.entryPrice) * trade.quantity).toFixed(3),
    stopProfit: trade.stopProfit,
    stopProfitEnabled: trade.stopProfitEnabled,
  }]);

  
  const netUnrealised = parseFloat(trade.unrealisedPnLNet || '0');
  const config = this.config;

  const realisedTP = (trade.entryPrice * trade.quantity) * (config.realisedTP || 0.20);
  // const targetPrice = trade.entryPrice * (1 + (config.realisedTP || 0.20));

  // Initialize tpHighestNetPnL if not already set
  if (trade.tpHighestNetPnL === undefined) {
    trade.tpHighestNetPnL = netUnrealised;
  }

  // 🎯 STEP 1: Realised TP threshold logic with enhanced logging
  if (netUnrealised >= 0) {
    //logInfo(`[${trade.symbol} 💰] Realised TP check: $${netUnrealised.toFixed(2)} ≥ $${realisedTP.toFixed(2)}, ${trade.entryPrice} --> $${targetPrice}, Quantity: ${trade.quantity}, Trade Value: $${(trade.entryPrice * trade.quantity).toFixed(2)}`);
  }

  // If unrealised PnL is negative, we skip the realised TP logic 
  if (netUnrealised > trade.tpHighestNetPnL) {
      logInfo(`[${this.name}] Trade ${trade.symbol}: 📈 New peak price — updated from $${trade.tpHighestNetPnL.toFixed(2)} to $${netUnrealised.toFixed(2)}.`);
      trade.tpHighestNetPnL = netUnrealised;
    }
  // If unrealised PnL is below the realised TP threshold, we start tracking the opportunity
  if (netUnrealised >= realisedTP) {
    if (!trade.tpOpportunityActive) {
      trade.tpOpportunityActive = true;
      trade.tpOpportunityFloor = realisedTP;
      trade.tpHighestNetPnL = netUnrealised;

      logInfo(`[${this.name}] Trade ${trade.symbol} (${trade.clientOrderId || trade.orderId}): 💰 Realised TP hit — base floor locked at $${realisedTP.toFixed(2)}.`);

      return {
        action: 'HOLD',
        reason: `Profit floor $${realisedTP} reached. Opportunity tracking started.`
      };
    }
    // If unrealised PnL is above the realised TP threshold, we continue tracking the opportunity
    if (netUnrealised > trade.tpHighestNetPnL) {
      logInfo(`[${this.name}] Trade ${trade.symbol}: 📈 New peak profit — updated from $${trade.tpHighestNetPnL.toFixed(2)} to $${netUnrealised.toFixed(2)}.`);
      trade.tpHighestNetPnL = netUnrealised;
    }

    const peak = trade.tpHighestNetPnL;
    const drop = peak - netUnrealised;
    const profitAboveFloor = peak - trade.tpOpportunityFloor;

    const absoluteThreshold = 0.30; // $0.30 absolute drop from peak
    const percentageThreshold = 0.03; // 3% drop from peak above floor
    // Calculate the drop threshold based on both absolute and percentage values
    const dropThreshold = Math.max(absoluteThreshold, percentageThreshold * profitAboveFloor);

    const pctFromPeak = profitAboveFloor > 0 ? ((drop / profitAboveFloor) * 100).toFixed(2) : '0.00';

    logInfo(`[${this.name}] Trade ${trade.symbol}: 🧮 Profit Tracking:
      ├─ Net PnL         : $${netUnrealised.toFixed(2)}
      ├─ Peak PnL        : $${peak.toFixed(2)}
      ├─ Floor PnL       : $${trade.tpOpportunityFloor.toFixed(2)}
      ├─ Drop From Peak  : $${drop.toFixed(2)} (${pctFromPeak}%)
      └─ Drop Threshold  : $${dropThreshold.toFixed(2)} (≥ triggers SELL)`);
    // If the drop exceeds the threshold, we trigger a SELL
    if (drop >= dropThreshold) {
      logInfo(`[${this.name}] Trade ${trade.symbol}: ❗ Profit drop triggered — dropped $${drop.toFixed(2)} from peak $${peak.toFixed(2)}. Executing SELL.`);
      return {
        action: 'SELL',
        reason: `Profit drop triggered: Lost $${drop.toFixed(2)} from $${peak.toFixed(2)}. Securing gains.`
      };
    }
    // If the drop is below the threshold, we continue holding
    logInfo(`[${this.name}] Trade ${trade.symbol}: ⏳ Holding opportunity. No exit yet — drop $${drop.toFixed(2)} is below $${dropThreshold.toFixed(2)} threshold.`);
    return {
      action: 'HOLD',
      reason: `Opportunity running. Net: $${netUnrealised.toFixed(2)}, Peak: $${peak.toFixed(2)}.`
    };
  }

  // 🛡️ Regular TP/SL/Trailing logic
  if (currentPrice >= trade.profitPrice) {
    trade.exitPrice = currentPrice;
    trade.profitReached = true;
    const profitGain = ((currentPrice - trade.entryPrice) * trade.quantity).toFixed(2);
    const fvgText = trade.fvg ? ` | FVG: ${trade.fvg.toFixed(3)}` : '';
    logInfo(`[${this.name}] Trade ${trade.symbol}: ✅ Take Profit hit.${fvgText} Current: $${currentPrice.toFixed(3)} ≥ TP: $${trade.profitPrice.toFixed(3)}. Profit Gain: $${profitGain}. (Entry: $${trade.entryPrice.toFixed(3)})`);
    return {
      action: 'SELL',
      reason: `Take Profit reached: ${currentPrice.toFixed(3)} ≥ ${trade.profitPrice.toFixed(3)} (Profit Gain: $${profitGain})`
    };
  }
// 📈 Trailing Stop logic
  if (trade.profitReached) {
    const previousHighest = trade.highestPrice;
    trade.highestPrice = Math.max(trade.highestPrice, currentPrice);
    trade.trailingStopPrice = trade.highestPrice * (1 - config.trailPct);
    const fvgText = trade.fvg ? ` | FVG: ${trade.fvg.toFixed(3)}` : '';
    logInfo(`[${this.name}] Trade ${trade.symbol}: Trailing active.${fvgText} Previous Highest: $${previousHighest.toFixed(3)}, New Highest: $${trade.highestPrice.toFixed(3)}. Trailing Stop recalculated: $${trade.trailingStopPrice.toFixed(3)} (Threshold: ${(config.trailPct * 100).toFixed(2)}%). Current Price: $${currentPrice.toFixed(3)}.`);

    if (currentPrice <= trade.trailingStopPrice) {
      const dropFromPeak = (trade.highestPrice - currentPrice).toFixed(3);
      const fvgTrigger = trade.fvg ? ` | FVG: ${trade.fvg.toFixed(3)}` : '';
      logInfo(`[${this.name}] Trade ${trade.symbol}: 🔻 Trailing Stop triggered.${fvgTrigger} Current: $${currentPrice.toFixed(3)} ≤ Trailing Stop: $${trade.trailingStopPrice.toFixed(3)}. Price dropped by $${dropFromPeak} from peak.`);
      return {
        action: 'HOLD',
        reason: `Trailing Stop: ${currentPrice.toFixed(3)} ≤ ${trade.trailingStopPrice.toFixed(3)} (Drop: $${dropFromPeak} from peak $${trade.highestPrice.toFixed(3)})`
      };
    }

    return {
      action: 'HOLD',
      reason: `Trailing active. Current: $${currentPrice.toFixed(3)} > Trailing Stop: $${trade.trailingStopPrice.toFixed(3)}.`
    };
  }
// 🛑 Stop Loss logic
  if (currentPrice <= trade.stopLossPrice) {
    const pnlMeasure = ((currentPrice - trade.entryPrice) * trade.quantity).toFixed(2);
    const safeguardDiff = (currentPrice - trade.stopLossPrice).toFixed(3);
    const riskReward = ((currentPrice - trade.entryPrice) / trade.entryPrice * 100).toFixed(2);
    const fvgText = trade.fvg ? ` | FVG: ${trade.fvg.toFixed(3)}` : '';
    logInfo(`[${this.name}] Trade ${trade.symbol}: 🛑 Stop Loss triggered.${fvgText} Current: $${currentPrice.toFixed(3)} ≤ StopLoss: $${trade.stopLossPrice.toFixed(3)}.`);
    logInfo(`[${this.name}] Trade ${trade.symbol}: Performance details: Entry: $${trade.entryPrice.toFixed(3)}, Current: $${currentPrice.toFixed(3)}, PnL: $${pnlMeasure}, Safeguard Diff: $${safeguardDiff}, Risk/Reward: ${riskReward}%.`);
    return {
      action: 'SELL',
      reason: `Stop Loss: ${currentPrice.toFixed(3)} ≤ ${trade.stopLossPrice.toFixed(3)} (PnL: $${pnlMeasure}, Risk/Reward: ${riskReward}%)`
    };
  }
// ☠️ Kill-Switch logic
  if (currentPrice <= trade.killSwitchPrice) {
    const expectedLoss = (trade.entryPrice - currentPrice).toFixed(3);
    const fvgText = trade.fvg ? ` | FVG: ${trade.fvg.toFixed(3)}` : '';
    logInfo(`[${this.name}] Trade ${trade.symbol}: ☠️ Kill-Switch triggered.${fvgText} Current: $${currentPrice.toFixed(3)} ≤ KillSwitch: $${trade.killSwitchPrice.toFixed(3)}.`);
    logInfo(`[${this.name}] Trade ${trade.symbol}: At Kill-Switch -> Entry: $${trade.entryPrice.toFixed(3)}, Current: $${currentPrice.toFixed(3)}, Expected Loss: $${expectedLoss}.`);
    return {
      action: 'SELL',
      reason: `Kill-Switch: ${currentPrice.toFixed(3)} ≤ ${trade.killSwitchPrice.toFixed(3)} (Expected Loss: $${expectedLoss})`
    };
  }

// 🏦 Stop Profit logic
  if (this.stopProfitEnabled && netUnrealised >= trade.stopProfit ) {
    logInfo(`[${this.name}] Trade ${trade.symbol} (${trade.clientOrderId || trade.orderId}): 💰 Stop Profit hit at $${trade.stopProfit.toFixed(2)}.`)
    return {
        action: 'SELL',
        reason: `Stop Profit floor $${trade.stopProfit} reached.`
      }
    };
// If none of the conditions are met, we hold the position

  return {
    action: 'HOLD',
    reason: `Unrealised PnL @$${netUnrealised.toFixed(2)}`
  };

}


aggregatePnLAndBroadcast() {
  
  let totalRealised = 0;
  let totalUnrealised = 0;
  let totalTradeValue = 0;
  let totalFees = 0;

  // Stats accumulators
  let wins = 0;
  let losses = 0;
  let profitSum = 0;
  let lossSum = 0;

  for (const trade of this.closedtrades) {
    const r = parseFloat(trade.realisedPnLNet);
    if (Number.isNaN(r)) continue;

    totalRealised += r;
    totalFees += parseFloat(trade.totalCommission || 0);

    if (r > 0) {
      wins++;
      profitSum += r;
    } else if (r < 0) {
      losses++;
      lossSum += Math.abs(r); // make loss positive for averaging
    }
  }

  for (const trade of Object.values(this.trades)) {
    if (String(trade.status).toUpperCase() === 'OPEN') {
      const u = parseFloat(trade.unrealisedPnLNet);
      if (!Number.isNaN(u)) totalUnrealised += u;
    }
    if (String(trade.status).toUpperCase() === 'TRADE') {
      const t = parseFloat(trade.unrealisedPnLNet);
      if (!Number.isNaN(t)) totalTradeValue += t;
    }
  }

  const totalTrades = wins + losses;
  const winRatio = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(2) : '0.00';
  const avgProfit = wins > 0 ? (profitSum / wins).toFixed(2) : '0.00';
  const totalProfit = profitSum.toFixed(2);
  const totalLoss   = lossSum.toFixed(2);
  const avgLoss   = losses > 0 ? (lossSum / losses).toFixed(2) : '0.00';

  // Update global PnL figures with the latest closed trade's results
  const lastClosedTrade = this.closedtrades[this.closedtrades.length - 1];
  if (lastClosedTrade) {
    ProfitLossPlugin.globalRealisedPnL += parseFloat(lastClosedTrade.realisedPnLNet || 0);
  }
  ProfitLossPlugin.globalUnrealisedPnL = totalUnrealised;

  const aggregatedSignal = {
    plugin: this.name,
    positions: this.trades,
    wallets: this.wallets,
    pnlwallets: this.pnlwallets,
    ledgerBalance: this.ledgerBalance,
    combinedRealisedPnL: totalRealised.toFixed(2),
    combinedUnrealisedPnL: totalUnrealised.toFixed(2),
    combinedTradeValue: totalTradeValue.toFixed(2),
    combinedPnL: (totalRealised + totalUnrealised).toFixed(2),
    stats: {
      totalTrades,
      wins,
      winRatio: `${winRatio}%`,
      totalProfit: `$${totalProfit}`,
      avgProfit: `$${avgProfit}`,
      totalLoss: `$${totalLoss}`,
      avgLoss: `$${avgLoss}`,
      totalFees: `$${totalFees.toFixed(2)}`
    }
  };

  // Log positions data for debugging
  if (!aggregatedSignal.positions || Object.keys(aggregatedSignal.positions).length === 0) {
    logWarn(`[${this.name}] Warning: Broadcasting signal with empty positions data.`);
    return;
  }

  const nullOrBlankKeys = Object.entries(aggregatedSignal)
    .filter(([key, value]) => value === null || value === '' || value === undefined)
    .map(([key]) => key);

  if (nullOrBlankKeys.length > 0) {
    console.log("******************** NULL OR BLANK FIELDS DETECTED ********************");
    console.log("The following fields are null or blank:", nullOrBlankKeys);
    return;
  }

  this.broadcastSignal(aggregatedSignal);
}

updateParams(options = {}) {
  // Update WS connection for kline data
  if (options.WS) {
    const baseUrl = options.WS;
    const params = new URLSearchParams();
    if (options.symbol)   params.append('symbol', options.symbol);
    if (options.duration) params.append('interval', options.duration);
    if (options.limit)    params.append('limit', options.limit);
    this.klineWS = `${baseUrl}`;
    // Also keep local duration and limit in sync.
    if (options.duration !== undefined) this.duration = options.duration;
    if (options.limit !== undefined)    this.limit    = options.limit;
  } else if (options.klineWS) {
    this.klineWS = options.klineWS;
  }

  // Update execution report URL if provided
  if (options.execReportURL !== undefined) {
    this.execReportURL = options.execReportURL;
  }

    // Update trading thresholds and fees in config
  if (options.profitperTrade !== undefined) {
    this.config.profitperTrade = options.profitperTrade;
  }

  // Update trading thresholds and fees in config
  if (options.profitThreshold !== undefined) {
    this.config.profitPct = options.profitThreshold;
  }
  if (options.lossThreshold !== undefined) {
    this.config.lossPct = options.lossThreshold;
  }
  if (options.killSwitchThreshold !== undefined) {
    // Ensure killPct is always positive
    this.config.killPct = Math.abs(options.killSwitchThreshold);
  }
  if (options.trailingStopThreshold !== undefined) {
    this.config.trailPct = options.trailingStopThreshold;
  }
  if (options.tradeProtection !== undefined) {
    this.config.tradeProtection = options.tradeProtection;
  }

  // Update symbol if provided
  if (options.symbol !== undefined) {
    this.symbol = options.symbol;
  }

  // Update commission fees
  if (options.makerFeePct !== undefined) {
    this.config.makerFeePct = options.makerFeePct;
  }
  if (options.takerFeePct !== undefined) {
    this.config.takerFeePct = options.takerFeePct;
  }
  if (options.bnbDiscountPct !== undefined) {
    this.config.bnbDiscountPct = options.bnbDiscountPct;
  }      
  if (options.realisedTP !== undefined) {
    this.config.realisedTP = options.realisedTP;
  }
  if (options.stopProfitEnabled !== undefined) {
    this.stopProfitEnabled = options.stopProfitEnabled;
  }
}

startPlugin(klineWS) {
  if (klineWS) {
    this.klineWS = klineWS;
    console.log(`[${this.name}] klineWS set to ${this.klineWS}`);
  }
  this.init();

  

  const SYMBOLS = [
      'ADAUSDT',
      'BTCUSDT',
      'ETHUSDT',
      'FUNUSDT',
      'FLOKIUSDT',
      'BNBUSDT',
      'XRPUSDT', 'XRPFDUSD',
      //'PEPEUSDT',
      'NEOUSDT',
      'ZROUSDT', 'ZROFDUSD', 'ZROBTC',
      'FDUSDUSDT',
      'USDTZAR',
      'XRPLUSD'
    ];
    
    this.symbols = new Set(SYMBOLS);
    this.initializeWebSocket(this.symbols);

    logInfo(`[${this.name}] Distinct symbols: ${[...this.symbols].join(', ')}`);

    this.initializeExecReportSocket();
    
    this.loadExecReports();
  }

restartWebSockets() {
  if (this.ws) {
    this.ws.close();
    this.initializeWebSocket();
    logInfo(`[${this.name}] kline WebSocket restarted.`);
  }

  if (this.execWS) {
    this.execWS.close();
    this.initializeExecReportSocket();
    logInfo(`[${this.name}] exec-report WebSocket restarted.`);
  }

  // Reinitialize all relevant variables
  this.trades = {};
  this.closedtrades = [];
  this.realisedPnL = 0;  this.wallets = {};
  this.pnlwallets = {};
  logInfo(`[${this.name}] All variables reinitialized.`);
  };

  // Debug method to check recycling service status
  getRecyclingServiceStatus() {
    if (!this.tradeRecyclingService) {
      return { error: 'TradeRecyclingService not initialized' };
    }
    
    return {
      candidatesCount: Object.keys(this.tradeRecyclingService.candidates).length,
      candidates: this.tradeRecyclingService.candidates,
      qualifiedCount: this.tradeRecyclingService.qualifiedCandidates.length,
      qualified: this.tradeRecyclingService.qualifiedCandidates,
      latestPrices: this.tradeRecyclingService.latestPrices,
      callbackRegistered: !!this.tradeRecyclingService.onQualifiedCandidate
    };
  }
}

module.exports = ProfitLossPlugin;
