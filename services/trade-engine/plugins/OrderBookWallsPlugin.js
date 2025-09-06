const WebSocket = require('ws');
const createPluginLogger = require('./pluginsLogger');
const { logInfo, logWarn, logError } =
createPluginLogger('OrderBookWallsPlugin') || require('../logger');
const WebSocketClient = require('../../../includes/WebSocketClient');
const util = require('util');


class OrderBookWallsPlugin {
  constructor(options = {}) {
    this.name = 'OrderBookWallsPlugin';
    this.ws = null;
    this.symbol = options.symbol || null;
    this.cobWebSocketUrl = options.cobWebSocketUrl || null;
    this.klineWS = options.klineWS || null;
    // Ensures cobWebSocketUrl always has the symbol as a query param
    this.duration = options.duration || '1m';
    this.limit = options.limit || 120;

    // track previous kline price for wall-break detection
    this.prevKlinePrice = null;
    // track last proximity state for deduplication
    this.lastProximity = { BUY: {}, SELL: {} };

    this.broadcastClient = new WebSocketClient(
      options.broadcastClientWS || 'ws://localhost:8083'
    );
    this.broadcastClient.on('open', () => {
      logInfo('Connected to broadcast server on port 8083.');
    });
    this.broadcastClient.on('error', (error) =>
      logError('WebSocket error:', error)
    );
    this.broadcastClient.on('close', () =>
      logWarn('WebSocket closed.')
    );

    // Wall detection config
    // To make wall percentages more sensitive, use a narrower priceRange and wider priceGrouping
    this.wallConfig = {
      priceRange: options.priceRange || 0.01,      // 1% around mid-price (was 3%)
      pricePrecision: options.pricePrecision || 4,
      priceGrouping: options.priceGrouping || 0.002, // 0.002 (was 0.0005)
      wallPercentage: options.wallPercentage || 10.0,
      blockIntervalSeconds: options.blockIntervalSeconds || 1,
      wallProximityPercent: options.wallProximityPercent || 0.4,
      persistWallsPercent: options.persistWallsPercent || 1,
        // Optional client order ID for tracking --? // This can be used to later to....
    };

    this.orderBook = { bids: [], asks: [] };
    this.isSnapshotLoaded = false;

    // trading signal state
    this.lastSignalAction = null;
    this.lastPrice = null;
    this.runningPnL = 0;
    this.signalCount = 0;

    // Arrays to track detected walls
    this.buyWalls = [];
    this.sellWalls = [];

    // Must have both URLs
    if (!this.cobWebSocketUrl) {
      throw new Error(
        'OrderBookWallsPlugin: cobWebSocketUrl (or WS) is required.'
      );
    }
    if (!this.klineWS) {
      throw new Error(
        'OrderBookWallsPlugin: klineWS is required for real-time price.'
      );
    }
  } // end constructor

  initializeWebSocket(orderBookWS) {
    if (orderBookWS) this.cobWebSocketUrl = orderBookWS;
    if (!this.cobWebSocketUrl) {
      logError(`[${this.name}] cobWebSocketUrl not provided.`);
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    logInfo(`[${this.name}] Connecting to ${this.cobWebSocketUrl}...`);
    this.ws = new WebSocket(this.cobWebSocketUrl);

    this.ws.on('message', (msg) => {
      let data;
      try { data = JSON.parse(msg); } catch (_) { return; }
      if (data.type === 'live_snapshot' && data.snapshot) {
        this.handleSnapshot(data.snapshot);
      } else if (data.type === 'depth_update' && data.data) {
        this.handleUpdate(data.data);
      } else if (data.snapshot) {
        this.handleSnapshot(data.snapshot);
      } else if (data.e === 'depthUpdate') {
        this.handleUpdate(data);
      }
    });

    this.ws.on('close', () => {
      logWarn(`[${this.name}] OrderBook WS closed. Reconnecting in 5s...`);
      setTimeout(() => this.initializeWebSocket(), 5000);
    });

    this.ws.on('error', (error) =>
      logError(`[${this.name}] OrderBook WS error: ${error.message}`)
    );
  }

  initializeKlineWebSocket(klineWS) {
    if (klineWS) this.klineWS = klineWS;
    if (!this.klineWS) return;
    if (this.klineSocket && this.klineSocket.readyState === WebSocket.OPEN)
      return;

    this.klineSocket = new WebSocket(this.klineWS);
    this.klineSocket.on('message', (msg) => {
      let data;
      try { data = JSON.parse(msg); } catch (_) { return; }
      if (data.k) {
        this.currentKlinePrice = parseFloat(data.k.c);
      } else if (data.price) {
        this.currentKlinePrice = parseFloat(data.price);
      } else if (data.c) {
        this.currentKlinePrice = parseFloat(data.c);
      }
    });

    this.klineSocket.on('close', () => {
      setTimeout(() => this.initializeKlineWebSocket(), 1000);
    });

    this.klineSocket.on('error', () => this.klineSocket.close());
  }

  handleSnapshot(snapshot) {
    this.orderBook = {
      bids: snapshot.bids.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      asks: snapshot.asks.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
    };
    this.isSnapshotLoaded = true;
    this.processWalls();
  }

  handleUpdate(update) {
    if (!this.isSnapshotLoaded) return;
    const applyDeltas = (side, deltas) => {
      deltas.forEach(([priceStr, qtyStr]) => {
        const price = parseFloat(priceStr);
        const qty   = parseFloat(qtyStr);
        let found = false;
        for (let i = 0; i < side.length; i++) {
          if (side[i][0] === price) {
            if (qty === 0) {
              side.splice(i, 1);
            } else {
              side[i][1] = qty;
            }
            found = true;
            break;
          }
        }
        if (!found && qty > 0) {
          side.push([price, qty]);
        }
      });
    };
    applyDeltas(this.orderBook.bids, update.b);
    applyDeltas(this.orderBook.asks, update.a);
    this.processWalls();
  }

  processWalls() {
    // --- Detect wall breaks ---
    if (this.prevKlinePrice != null && (this.buyWalls.length + this.sellWalls.length) > 0) {
      const broken = [];
      this.buyWalls.forEach(w => {
        if (this.prevKlinePrice >= w.price && this.currentKlinePrice < w.price) {
          broken.push({ ...w, side: 'BUY' });
        }
      });
      this.sellWalls.forEach(w => {
        if (this.prevKlinePrice <= w.price && this.currentKlinePrice > w.price) {
          broken.push({ ...w, side: 'SELL' });
        }
      });
      if (broken.length) {
        logInfo(`[${this.name}] Wall broken through, resetting signals.`);
        this.broadcastSignal({
          type: 'graphMessage',
          plugin: this.name,
          symbol: this.symbol,
          action: 'reset',
          brokenWalls: broken
        });
        this.lastSignalAction = null;
      }
    }
    this.prevKlinePrice = this.currentKlinePrice;

    // --- Standard wall detection & signaling ---
    this.orderBook.bids.sort((a, b) => b[0] - a[0]);
    this.orderBook.asks.sort((a, b) => a[0] - b[0]);
    const bestBid = this.orderBook.bids[0]?.[0];
    const bestAsk = this.orderBook.asks[0]?.[0];
    if (!bestBid || !bestAsk || this.currentKlinePrice == null) {
      logError(`[${this.name}] Missing price data, skipping wall processing.`);
      return;
    }

    const midPrice  = (bestBid + bestAsk) / 2;
    const rangeAmt  = midPrice * this.wallConfig.priceRange;
    const minPrice  = midPrice - rangeAmt;
    const maxPrice  = midPrice + rangeAmt;
    const groupSize = this.wallConfig.priceGrouping;
    const buckets   = [];
    for (let p = minPrice; p <= maxPrice; p += groupSize) {
      buckets.push(parseFloat(p.toFixed(this.wallConfig.pricePrecision)));
    }

    const calcVolumes = (side) => {
      const m = new Map();
      buckets.forEach((start, idx) => {
        const end = start + groupSize;
        const vol = side
          .filter(([px]) => px >= start && px < end)
          .reduce((sum, [, q]) => sum + q, 0);
        if (vol > 0) m.set(idx, vol);
      });
      return m;
    };
    const bidVolumes = calcVolumes(this.orderBook.bids);
    const askVolumes = calcVolumes(this.orderBook.asks);
    const totalBid   = Array.from(bidVolumes.values()).reduce((a, b) => a + b, 0);
    const totalAsk   = Array.from(askVolumes.values()).reduce((a, b) => a + b, 0);

    const now    = Date.now();
    const newBuys = [];
    const newSells = [];

    let prox = this.wallConfig.wallProximityPercent;
    //logInfo(`[${this.name}] Using proximity threshold: ${prox}%`);

    // BUY walls
    bidVolumes.forEach((vol, idx) => {
      const pct = totalBid > 0 ? (vol / totalBid) * 100 : 0;
      if (pct >= this.wallConfig.wallPercentage) {
        const price    = buckets[idx];
        const prev     = this.buyWalls.find(w => w.price === price);
        const detectedAt = prev && Math.abs(prev.percentage - pct) <= this.wallConfig.persistWallsPercent
          ? prev.detectedAt : now;
        const refPrice = this.currentKlinePrice;
        const distance = Math.abs(refPrice - price);
        const pctDist  = (distance / price) * 100;
        newBuys.push({ symbol: this.symbol, price, volume: vol, percentage: pct, detectedAt, lastUpdated: now, distance, pctDist });

       //logInfo(`[${this.name}] BUY wall @ ${price} (${pct.toFixed(2)}%) dist=${distance}`);
        const key     = price.toFixed(this.wallConfig.pricePrecision);
        const wasIn   = this.lastProximity.BUY[key] === true;
        const nowIn   = pctDist <= prox;
        if (nowIn && (!wasIn || this.lastSignalAction !== 'BUY')) {
          const prevAction = this.lastSignalAction;
          if (this.lastPrice != null) this.runningPnL += (refPrice - this.lastPrice);
          this.lastPrice       = refPrice;
          this.signalCount++;
          this.lastSignalAction = 'BUY';
          //logInfo(`[${this.name}] Emitting BUY signal #${this.signalCount}, runningPnL=${this.runningPnL}`);
          this.broadcastSignal({
            type: 'signal',
            plugin: this.name,
            symbol: this.symbol,
            side: 'BUY',
            orderBookPrice: price,
            klinePrice: refPrice,
            percentage: pct,
            volume: vol,
            pctDist,
            midPrice,
            runningPnL: this.runningPnL,
            runningPnLDollarValue: this.runningPnL * refPrice,
            action: 'BUY',
            laction: prevAction
          });
        }
        this.lastProximity.BUY[key] = nowIn;
      }
    });

    // SELL walls
    askVolumes.forEach((vol, idx) => {
      const pct = totalAsk > 0 ? (vol / totalAsk) * 100 : 0;
      if (pct >= this.wallConfig.wallPercentage) {
        const price     = buckets[idx];
        const prev      = this.sellWalls.find(w => w.price === price);
        const detectedAt = prev && Math.abs(prev.percentage - pct) <= this.wallConfig.persistWallsPercent
          ? prev.detectedAt : now;
        const refPrice  = this.currentKlinePrice;
        const distance  = Math.abs(refPrice - price);
        const pctDist   = (distance / price) * 100;
        newSells.push({ symbol: this.symbol, price, volume: vol, percentage: pct, detectedAt, lastUpdated: now, distance, pctDist });

       // logInfo(`[${this.name}] SELL wall @ ${price} (${pct.toFixed(2)}%) dist=${distance}`);
        const key     = price.toFixed(this.wallConfig.pricePrecision);
        const wasIn   = this.lastProximity.SELL[key] === true;
        const nowIn   = pctDist <= prox;
        if (nowIn && (!wasIn || this.lastSignalAction !== 'SELL')) {
          const prevAction = this.lastSignalAction;
          if (this.lastPrice != null) this.runningPnL += (refPrice - this.lastPrice);
          this.lastPrice       = refPrice;
          this.signalCount++;
          this.lastSignalAction = 'SELL';
          //logInfo(`[${this.name}] Emitting SELL signal #${this.signalCount}, runningPnL=${this.runningPnL}`);
          this.broadcastSignal({
            type: 'signal',
            plugin: this.name,
            symbol: this.symbol,
            side: 'SELL',
            orderBookPrice: price,
            klinePrice: refPrice,
            percentage: pct,
            volume: vol,
            pctDist,
            midPrice,
            runningPnL: this.runningPnL,
            runningPnLDollarValue: this.runningPnL * refPrice,
            action: 'SELL',
            laction: prevAction
          });
        }
        this.lastProximity.SELL[key] = nowIn;
      }
    });

    this.buyWalls  = newBuys;
    this.sellWalls = newSells;
    this.visualizeWalls();
  }

    visualizeWalls() {
        if (this.buyWalls.length) {
            this.broadcastSignal({
                plugin: this.name,
                symbol: this.symbol,
                type: 'graphMessage',
                buyWalls: this.buyWalls
            });
        }
        if (this.sellWalls.length) {
            this.broadcastSignal({
                plugin: this.name,
                symbol: this.symbol,
                type: 'graphMessage',
                sellWalls: this.sellWalls
            });
        }
    }
  

  broadcastSignal(signalData) {
    if (signalData && typeof signalData === 'object' && Object.keys(signalData).length > 0 && signalData.type && signalData.type !== 'signal') {
      //logInfo(`[${this.name}] Signal data:\n${util.inspect(signalData, { depth: null, colors: true })}`);
        // Flatten signalData, don't wrap inside another object
        const message = { ...signalData, timestamp: Date.now() };
        // Only broadcast if message contains meaningful signal data
        const relevantKeys = [
          'buyWalls', 'sellWalls', 'side', 'brokenWalls', 'action', 'percentage', 'volume', 'orderBookPrice', 'klinePrice'
        ];
        const hasRelevantData = relevantKeys.some(key => key in message && message[key] !== undefined && message[key] !== null && !(Array.isArray(message[key]) && message[key].length === 0));
        if (!hasRelevantData) {
            logWarn(`[${this.name}] No relevant signal data, not broadcasting.`);
            return;
        }
        //logInfo(`[${this.name}] Broadcasting signal:`, { ...message });
        this.broadcastClient.send(message);
    } else {
        logWarn(`[${this.name}] Invalid signal data, not broadcasting.`);
    }
}

  updateParams(options = {}) {
    if (options.wallProximityPercent !== undefined)
      this.wallConfig.wallProximityPercent = options.wallProximityPercent;
    if (options.persistWallsPercent !== undefined)
      this.wallConfig.persistWallsPercent = options.persistWallsPercent;
    if (options.priceRange !== undefined)
      this.wallConfig.priceRange = options.priceRange;
    if (options.pricePrecision !== undefined)
      this.wallConfig.pricePrecision = options.pricePrecision;
    if (options.priceGrouping !== undefined)
      this.wallConfig.priceGrouping = options.priceGrouping;
    if (options.wallPercentage !== undefined)
      this.wallConfig.wallPercentage = options.wallPercentage;
    if (options.blockIntervalSeconds !== undefined)
      this.wallConfig.blockIntervalSeconds = options.blockIntervalSeconds;
    if (options.clientOrderId !== undefined)
      this.wallConfig.clientOrderId = options.clientOrderId;

    if (options.WS || options.klineWS) {
      const base = options.WS || options.klineWS;
      const params = new URLSearchParams();
      const sym = options.symbol || this.symbol;
      if (sym) params.append('symbol', sym);
      params.append('interval', options.duration || this.duration);
      params.append('limit', options.limit || this.limit);
      this.klineWS = `${base}?${params}`;
      logInfo(`[${this.name}] klineWS updated: ${this.klineWS}`);
    }

    if (options.symbol !== undefined) this.symbol = options.symbol;
    if (options.cobWebSocketUrl) {
      const sep = options.cobWebSocketUrl.includes('?') ? '&' : '?';
      this.cobWebSocketUrl = `${options.cobWebSocketUrl}${sep}symbol=${this.symbol}`;
    }

    if (!this.cobWebSocketUrl) {
      throw new Error('OrderBookWallsPlugin: cobWebSocketUrl is required.');
    }
    if (!this.klineWS) {
      throw new Error('OrderBookWallsPlugin: klineWS is required.');
    }
    logInfo(`[${this.name}] Params updated`, this.wallConfig);
  }

  startPlugin(cobWebSocketUrl, klineWS) {
    if (cobWebSocketUrl) this.cobWebSocketUrl = cobWebSocketUrl;
    if (klineWS) {
      this.klineWS = klineWS;
      logInfo(`[${this.name}] Starting with klineWS: ${this.klineWS}`);
      try {
        const sym = new URL(klineWS).searchParams.get('symbol');
        if (sym) {
          this.symbol = sym;
          logInfo(`[${this.name}] Symbol set from WS: ${this.symbol}`);
        }
      } catch (err) {
        logWarn(`[${this.name}] Could not parse symbol from klineWS: ${err.message}`);
      }
    }

    if (!this.cobWebSocketUrl) {
      throw new Error('OrderBookWallsPlugin: cobWebSocketUrl is required.');
    }
    if (!this.klineWS) {
      throw new Error('OrderBookWallsPlugin: klineWS is required.');
    }

    this.initializeWebSocket(this.cobWebSocketUrl);
    this.initializeKlineWebSocket(this.klineWS);
    logInfo(`[${this.name}] Plugin started.`);
  }
}

module.exports = OrderBookWallsPlugin;
