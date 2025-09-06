/**
 * PluginChartCOB: A chart plugin to visualize Consolidated Order Book (COB) data as a heatmap.
 * It connects to a WebSocket service providing order book snapshots and updates.
 */
class PluginChartCOB {
  /**
          min: 1, // Reversed for empty case
          max: 0,
          splitLine: { show: false },
          axisLine: { show: false },
          // Ensure numeric value axis is inverted so numeric prices map to the
          // same vertical orientation as the category-based heatmap Y axis.
          // This makes minPrice appear at the same visual row as priceAxisData[0].
          inverse: true
   * @param {number} [options.priceRange=0.03] - The percentage range (e.g., 0.03 for 3%) around the mid-price to display.
   * @param {number} [options.pricePrecision=4] - The number of decimal places for price levels.
   * @param {number} [options.priceGrouping=0.0005] - The size of price buckets for aggregation. Larger values create thicker bars.
   * @param {number} [options.percentageThresholdForLabel=10.0] - Minimum percentage to display a text label on the heatmap.
   * @param {boolean} [options.showPercentageInLabels=false] - Whether to show percentage values in labels (false shows only +/- volume).
   * @param {number} [options.minDataPointsForVWAP=20] - Minimum data points before showing VWAP line (prevents erratic early display).
   * @param {number} [options.maxHistory=120] - The number of historical time slices to show on the chart (display limit).
   * @param {number} [options.maxHeatmapHistory=120] - The number of historical time slices to store for heatmap data (storage limit).
   * @param {boolean} [options.adaptiveGranularity=true] - Enable adaptive granularity based on distance from VWAP.
   * @param {number} [options.vwapZoneRange=0.007] - The range around VWAP (as percentage) for fine granularity.
   * @param {number} [options.distantWallThreshold=10.0] - Minimum percentage threshold for showing distant walls.
   * @param {boolean} [options.enablePriceLine=true] - Enable simple price line overlay on the heatmap.
   * @param {number} [options.priceLineOpacity=0.9] - Opacity of the price line overlay (0.0 to 1.0).
  * @param {string} [options.priceLineColor='#1684c9'] - Color of the price line (default: yellow).
   * @param {number} [options.priceLineWidth=2] - Width of the price line in pixels.
   * @param {string} [options.klineWebSocketUrl] - Optional WebSocket URL for real-time kline/candlestick data (for faster price line updates).
   * 
   * NEW: Percentage-based heatmap intensity
   * The heatmap now calculates the percentage of total volume at each price level within each time slice.
   * This helps identify the most significant liquidity areas regardless of overall market activity.
   * Color intensity is based on percentage thresholds:
   * - 10%+: Maximum intensity (darkest colors)
   * - 5-10%: High intensity 
   * - 2-5%: Medium intensity
   * - 1-2%: Low-medium intensity
   * - 0.5-1%: Low intensity
   * - <0.5%: Minimal intensity (lightest colors)
   * 
   * VWAP Band: A Volume Weighted Average Price line is displayed in gold, showing the cumulative
   * volume-weighted average price over time. This helps identify key price levels and trend direction.
   * 
   * Price Line Overlay (UPDATED): A simple yellow price line shows real-time price movements. 
   * When klineWebSocketUrl is provided, the price line uses dedicated kline/candlestick WebSocket data 
   * for ultra-fast updates (sub-second). Otherwise, it falls back to order book mid-price data.
   * The price line is perfectly synchronized with the heatmap time intervals for precise tracking.
   * 
   * Labels: Significant liquidity levels show labels with:
   * - Bids: "+volume" (e.g., "+450k") 
   * - Asks: "-volume" (e.g., "-380k")
   * - Optional: Set showPercentageInLabels=true to include percentage values
   * 
   * History Management:
   * - maxHistory: Controls how many time slices are DISPLAYED on the chart (affects performance)
   * - maxHeatmapHistory: Controls how many time slices are STORED in memory (affects memory usage)
   * - Typically set maxHeatmapHistory >= maxHistory for smooth scrolling capability
   * 
   * Adaptive Granularity (NEW):
   * - adaptiveGranularity: When true, uses fine detail near VWAP, coarser detail at distance
   * - vwapZoneRange: The percentage range around VWAP where fine granularity is maintained
   * - distantWallThreshold: Only show liquidity above this percentage threshold in distant areas
   * - This dramatically reduces visual noise while highlighting significant walls
   * - Provides smooth, flicker-free rendering by reducing data points
   */

  /*
  Settings Explanation:
priceRange: 0.0106 - This is 1.06% which will show approximately 1.06% above and below the mid-price, giving a range you of 3.234-3.2685 for XRPUSDT at a mid-price of 3.25125

pricePrecision: 4 - Keeps 4 decimal places (like 1.1234)

priceGrouping: 0.0005 - Changed from 0.002 to 0.0005 to give you finer granularity. This means each price row will represent 0.0005 (0.5 basis points).

3.2340, 3.2345, 3.2350, 3.2355, etc.
This gives you about 69 price levels.
Alternative Settings:
If you want even finer granularity:

priceGrouping: 0.0001 - Would give you 345 price levels (every 0.1 basis point)
priceGrouping: 0.001 - Would give you ~35 price levels (every 1 basis point)
If you want to ensure you capture exactly that range regardless of current mid-price fluctuations, you might want to increase priceRange slightly to 0.012 to give some buffer.

Usage Examples:

// Basic usage with order book heatmap only
const chart = new PluginChartCOB({
  containerId: 'chart-container',
  cobWebSocketUrl: 'ws://localhost:8080',
  symbol: 'BTCUSDT'
});

// Advanced usage with real-time kline price line for ultra-fast price updates
const chart = new PluginChartCOB({
  containerId: 'chart-container', 
  cobWebSocketUrl: 'ws://localhost:8080',
  symbol: 'BTCUSDT',
  enablePriceLine: true,
  klineWebSocketUrl: 'wss://stream.binance.com:9443/ws' // Will auto-append btcusdt@kline_1s
});

// Full Binance example with explicit kline stream
const chart = new PluginChartCOB({
  containerId: 'chart-container',
  cobWebSocketUrl: 'ws://localhost:8080', 
  symbol: 'BTCUSDT',
  enablePriceLine: true,
  klineWebSocketUrl: 'wss://stream.binance.com:9443/ws/btcusdt@kline_1s'
});
*/

  constructor(options = {}) {
    this.options = {
      // priceRange is a fraction of midPrice (e.g. 0.03 = 3%). Set to 3% by default.
      priceRange: 0.03, // was 0.7 (70%) — changed to 0.03 (3%) to match comments
      pricePrecision: 4, // 0.0000 for 4 decimal places (good for this price range)
      priceGrouping: 0.0008, // Smaller buckets for better granularity (0.5 basis points)
  percentageThresholdForLabel: 0.05, // 5% threshold for showing labels
  showPercentageInLabels: false, // Set to true to show percentages in labels
  labelMinVolume: 0, // Always allow label if percentage threshold is met
  labelRoundTo: 1, // Show actual volume, not rounded to 1000
      minDataPointsForVWAP: 5, // Minimum data points before showing VWAP (configurable)
      maxHistory: 30, // Default history to DISPLAY on chart (30 seconds at 1s intervals)
      maxHeatmapHistory: 30, // Default history to STORE for heatmap data (30 seconds)
      adaptiveGranularity: true, // Enable adaptive granularity based on VWAP distance
      vwapZoneRange: 0.007, // 0.7% range around VWAP for fine granularity
      distantWallThreshold: 0.1, // 0.1% threshold for distant walls
      enablePriceLine: true, // Enable simple price line overlay
      // Opacity of price line overlay
      // Use 6-digit hex for compatibility; control alpha via priceLineOpacity
      priceLineColor: '#ffd600', // Bright yellow stands out over red and green
      priceLineOpacity: 0.9, // Opacity for the price line (0.0 - 1.0)
      priceLineWidth: 4, // Width of price line
      debug: false, // When true, emit console.debug info for price range and buckets
      percentageThresholdColorVariance: 8, // Default % threshold for lower volume
      maxPercentageThresholdColorVariance: 30, // Default maximum % threshold for higher volume
  // Labeling controls: only create textual summary labels for price levels
  // when the raw volume meets a minimum threshold. Rounds displayed value
  // to the nearest `labelRoundTo` (e.g. 5000 for 5k, 10000 for 10k).
  labelMinVolume: 0,
  labelRoundTo: 1,
      ...options,
    };

    if (!options.containerId || !options.cobWebSocketUrl || !options.symbol) {
      throw new Error("PluginChartCOB: containerId, cobWebSocketUrl, and symbol are required options.");
    }

    this.containerId = this.options.containerId;
    // Ensure symbol is only appended if not already present in the URL
    let url = this.options.cobWebSocketUrl;
    if (!url.includes('?')) {
      url += `?symbol=${this.options.symbol}`;
    } else if (!url.includes('symbol=')) {
      url += `&symbol=${this.options.symbol}`;
    }
    this.cobWebSocketUrl = url;
    
    // Setup kline WebSocket URL if provided
    if (this.options.klineWebSocketUrl) {
      let klineUrl = this.options.klineWebSocketUrl; 
      // For Binance-style kline streams, construct the URL properly
      if (klineUrl.includes('binance') || klineUrl.includes('stream')) {
        // Assume Binance WebSocket format: wss://stream.binance.com:9443/ws/btcusdt@kline_1s
        const symbol = this.options.symbol.toLowerCase();
        if (!klineUrl.includes(symbol)) {
          // If URL doesn't already contain symbol, append it
          klineUrl = klineUrl.endsWith('/') ? klineUrl : klineUrl + '/';
          klineUrl += `${symbol}@kline_1s`;
        }
      }
      this.klineWebSocketUrl = klineUrl;
    } else {
      this.klineWebSocketUrl = null;
    }
    
    this.chartInstance = null;

    this.orderBook = { bids: [], asks: [] };
    this.heatmapDataBids = []; // Data for bids heatmap
    this.heatmapDataAsks = []; // Data for asks heatmap
    this.timeAxisData = []; // Labels for the X-axis (timestamps)
    this.priceAxisData = []; // Labels for the Y-axis (price levels)
    this.labelData = []; // Data for persistent labels

    this.trackedLevels = { bids: {}, asks: {} }; // Track persistent liquidity levels
    this.lastUpdateTime = null; // Property to track the last update second
    this.isSnapshotLoaded = false;
    this.isRendering = false;
    this.updateQueued = false;
    this.updateTimeout = null; // Timeout for debounced heatmap updates
    this.immediatePriceTimeout = null; // Timeout for immediate price line updates
    
    // VWAP calculation properties
    this.vwapData = []; // Array to store VWAP values for each time slice
    this.cumulativePriceVolume = 0; // Running sum of price * volume
    this.cumulativeVolume = 0; // Running sum of volume
    this.vwapHistory = []; // Historical VWAP values for charting
    this.vwapStartTime = null; // Track when VWAP calculation started
    
    // Current VWAP for adaptive granularity calculations
    this.currentVWAP = null;
    
    // Price line data properties (now updated from dedicated kline WebSocket for real-time accuracy)
    this.priceLineHistory = []; // Historical mid-prices for charting: [timeIndex, midPrice]
    this.currentKlinePrice = null; // Current price from kline data
    this.klineSocket = null; // Dedicated kline WebSocket connection
  }

  /**
   * Returns computed price range info for current order book mid-price.
   * Useful for debugging in the browser console: chart.getPriceRangeInfo()
   */
  getPriceRangeInfo() {
    if (this.orderBook.bids.length === 0 || this.orderBook.asks.length === 0) return null;
    this.orderBook.bids.sort((a, b) => b[0] - a[0]);
    this.orderBook.asks.sort((a, b) => a[0] - b[0]);
    const bestBid = this.orderBook.bids[0][0];
    const bestAsk = this.orderBook.asks[0][0];
    const midPrice = (bestBid + bestAsk) / 2;
    const priceRange = midPrice * this.options.priceRange;
    const minPrice = midPrice - priceRange;
    const maxPrice = midPrice + priceRange;
    const priceGrouping = this.options.priceGrouping;
    const startBucket = Math.floor(minPrice / priceGrouping) * priceGrouping;
    const buckets = [];
    for (let p = startBucket; p <= maxPrice + 1e-12; p += priceGrouping) {
      buckets.push(p);
      if (buckets.length > 20000) break;
    }
    return {
      midPrice,
      configuredPriceRange: this.options.priceRange,
      priceRange,
      minPrice,
      maxPrice,
      priceGrouping,
      startBucket,
      bucketCount: buckets.length,
      sampleBuckets: buckets.slice(0, 10)
    };
  }

  /**
   * Merge and apply new runtime options.
   * newOpts: partial options object. This attempts to apply changes live.
   */
  updateOptions(newOpts = {}) {
    try {
      // Merge shallowly
      this.options = Object.assign({}, this.options || {}, newOpts);

      // If price line enable state changed, start/stop kline socket accordingly
      if (!this.options.enablePriceLine) {
        // disable price line: close kline socket if present
        if (this.klineSocket) {
          try { this.klineSocket.close(); } catch(e){}
          this.klineSocket = null;
        }
      } else {
        // enable price line and ensure socket exists if URL provided
        if (this.klineWebSocketUrl && !this.klineSocket) {
          try { this.initializeKlineWebSocket(); } catch(e) { console.warn('initializeKlineWebSocket failed', e); }
        }
      }

      // If klineWebSocketUrl itself changed, restart connection
      if (newOpts.klineWebSocketUrl !== undefined) {
        // rebuild kline URL and restart socket
        this.klineWebSocketUrl = newOpts.klineWebSocketUrl;
        if (this.klineSocket) {
          try { this.klineSocket.close(); } catch(e){}
          this.klineSocket = null;
        }
        if (this.klineWebSocketUrl && this.options.enablePriceLine) {
          try { this.initializeKlineWebSocket(); } catch(e){ console.warn('kline init failed', e); }
        }
      }

      // Trigger safe update: prefer scheduleUpdate, fallback to heatmap update + render
      if (typeof this.scheduleUpdate === 'function') {
        this.scheduleUpdate();
      } else if (typeof this.updateHeatmapData === 'function' && typeof this.renderChart === 'function') {
        try { this.updateHeatmapData(); this.renderChart(); } catch(e) { console.warn('updateOptions update failed', e); }
      } else if (typeof this.resize === 'function') {
        try { this.resize(); } catch(e){}
      }
    } catch (err) {
      console.warn('PluginChartCOB.updateOptions failed', err);
    }
  }

  /**
   * Initializes the chart and WebSocket connection.
   */
  initialize() {
    const container = document.getElementById(this.containerId);
    if (!container) {
      console.error(`PluginChartCOB: container not found: #${this.containerId}`);
      return;
    }

    this.chartInstance = echarts.init(container);

    this.initializeWebSocket();
    
    // Initialize dedicated kline WebSocket if URL provided for real-time price line updates
    if (this.klineWebSocketUrl && this.options.enablePriceLine) {
      this.initializeKlineWebSocket();
    }
    
    // Initial empty render will happen when first data arrives
    window.addEventListener('resize', () => this.resize());
  }

  /**
   * Establishes connection to the COB WebSocket service.
   */
  initializeWebSocket() {
    const socket = new WebSocket(this.cobWebSocketUrl);

    socket.onopen = () => {
      // COB WebSocket connected silently
    };

    socket.onmessage = (event) => {
      const dataPromise = event.data instanceof Blob ? event.data.text() : Promise.resolve(event.data);

      dataPromise.then(rawData => {
        try {
          const data = JSON.parse(rawData);
          if (data.error) {
            // Received error from server - closing connection silently
            socket.close();
            return;
          }
          
          // Handle different message types from the server
          if (data.type === 'live_snapshot' && data.snapshot) {
            this.handleSnapshot(data.snapshot);
          } else if (data.type === 'depth_update' && data.data) {
            // Process real-time depth updates - this is the critical path
            this.handleUpdate(data.data);
          } else if (data.type === 'historical' && data.snapshot) {
            // Handle historical snapshots
            this.handleSnapshot(data.snapshot);
          } else if (data.type === 'resync' && data.snapshot) {
            this.handleSnapshot(data.snapshot);
          } else if (data.snapshot) {
            // Legacy: direct snapshot (backward compatibility)
            this.handleSnapshot(data.snapshot);
          } else if (data.e === 'depthUpdate') {
            // Legacy: direct Binance format (backward compatibility)
            this.handleUpdate(data);
          } else {
            // Unknown message type, ignoring silently
          }
        } catch (err) {
          // Failed to parse JSON from WebSocket message - ignoring silently
        }
      });
    };

    socket.onclose = () => {
      // COB WebSocket closed, reconnecting silently
      setTimeout(() => this.initializeWebSocket(), 5000);
    };

    socket.onerror = (error) => {
      // COB WebSocket error, closing connection silently
      socket.close();
    };
  }

  /**
   * Establishes connection to the dedicated kline WebSocket for real-time price data.
   * This provides much faster price updates than the order book WebSocket.
   */
  initializeKlineWebSocket() {
    if (!this.klineWebSocketUrl) return;
    
    this.klineSocket = new WebSocket(this.klineWebSocketUrl);

    this.klineSocket.onopen = () => {
      // Kline WebSocket connected silently
    };

    this.klineSocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        // Handle Binance kline data format
        if (data.k) {
          const kline = data.k;
          const closePrice = parseFloat(kline.c); // Close price is the current price
          this.handleKlineUpdate(closePrice);
        }
        // Handle other kline formats if needed
        else if (data.price) {
          this.handleKlineUpdate(parseFloat(data.price));
        }
        // Handle ticker format
        else if (data.c) {
          this.handleKlineUpdate(parseFloat(data.c));
        }
      } catch (err) {
        // Failed to parse kline WebSocket message - ignoring silently
      }
    };

    this.klineSocket.onclose = () => {
      // Kline WebSocket closed, reconnecting silently
      setTimeout(() => this.initializeKlineWebSocket(), 1000); // Faster reconnection for price data
    };

    this.klineSocket.onerror = (error) => {
      // Kline WebSocket error, closing connection silently
      this.klineSocket.close();
    };
  }

  /**
   * Handles real-time kline price updates for the price line.
   * @param {number} price - Current price from kline data
   */
  handleKlineUpdate(price) {
    if (!this.options.enablePriceLine || !price) return;
    
    this.currentKlinePrice = price;
    
    // Update price line with current kline price using heatmap's time synchronization
    if (this.timeAxisData.length > 0) {
      const timeIndex = this.timeAxisData.length - 1;
      
      // Replace or add the most recent price point
      if (this.priceLineHistory.length > 0 && this.priceLineHistory[this.priceLineHistory.length - 1][0] === timeIndex) {
        // Update existing point for current time slice
        this.priceLineHistory[this.priceLineHistory.length - 1] = [timeIndex, price];
      } else {
        // Add new point
        this.priceLineHistory.push([timeIndex, price]);
      }
      
      // Keep price line history aligned with heatmap history
      while (this.priceLineHistory.length > this.options.maxHistory) {
        this.priceLineHistory.shift();
      }
      
      // Trigger immediate chart render for real-time price line updates (bypass debouncing)
      this.scheduleImmediatePriceUpdate();
      // Debug logging for kline updates
      if (this.options.debug) {
        console.debug('PluginChartCOB: handleKlineUpdate', {
          klinePrice: price,
          currentKlinePrice: this.currentKlinePrice,
          lastPriceLinePoint: this.priceLineHistory.length ? this.priceLineHistory[this.priceLineHistory.length - 1] : null,
          timeIndex
        });
      }
    }
  }

  /**
   * Updates the price line history with current mid-price from order book data.
   * This is called automatically during heatmap updates, but only as fallback if kline data is not available.
   * @param {number} midPrice - Current mid-price from order book
   * @param {number} timeIndex - Current time index from heatmap
   */
  updatePriceLine(midPrice, timeIndex) {
    if (!this.options.enablePriceLine) return;
    
    // If we have a dedicated kline WebSocket, prefer that data over order book mid-price
    if (this.klineWebSocketUrl && this.currentKlinePrice !== null) {
      // Use kline price instead of order book mid-price for more accurate real-time data
      const priceToUse = this.currentKlinePrice;
      
      // Replace or add the price point for current time slice
      if (this.priceLineHistory.length > 0 && this.priceLineHistory[this.priceLineHistory.length - 1][0] === timeIndex) {
        this.priceLineHistory[this.priceLineHistory.length - 1] = [timeIndex, priceToUse];
      } else {
        this.priceLineHistory.push([timeIndex, priceToUse]);
      }
    } else {
      // Fallback to order book mid-price if no kline data available
      this.priceLineHistory.push([timeIndex, midPrice]);
    }
    
    // Keep price line history aligned with heatmap history
    while (this.priceLineHistory.length > this.options.maxHistory) {
      this.priceLineHistory.shift();
    }
  }

  /**
   * Aligns timestamps for consistent time display across data sources.
   * @param {number} timestamp - Unix timestamp
   * @returns {string} Formatted timestamp string
   */
  alignTimestamp(timestamp) {
    return new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ');
  }

  /**
   * Processes the initial order book snapshot.
   * @param {object} snapshot - The full order book snapshot.
   */
  handleSnapshot(snapshot) {
    this.orderBook = {
      bids: snapshot.bids.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      asks: snapshot.asks.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
    };

    // Initialize time axis with current time when first snapshot arrives
    const now = new Date();
    this.timeAxisData.push(`${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`);

    // Initialize VWAP calculation for snapshot
    this.updateVWAP();

    this.isSnapshotLoaded = true;
  this.scheduleUpdate(); // This will trigger the first real chart render
  }

  /**
   * Processes an incremental order book update.
   * @param {object} update - The depth update event data.
   */
  handleUpdate(update) {
    if (!this.isSnapshotLoaded) {
      return;
    }

    const applyDeltas = (side, deltas) => {
      deltas.forEach(([priceStr, qtyStr]) => {
        const price = parseFloat(priceStr);
        const qty = parseFloat(qtyStr);
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

    this.scheduleUpdate();
  }

  /**
   * Schedules a chart update to avoid re-rendering on every single message.
   * Uses a debounce mechanism to limit update frequency.
   */
  scheduleUpdate() {
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
    }

    this.updateTimeout = setTimeout(() => {
      if (this.isRendering) {
        this.updateQueued = true;
        return;
      }
      this.isRendering = true;
      requestAnimationFrame(() => {
        this.updateHeatmapData();
        this.renderChart();
        this.isRendering = false;
        if (this.updateQueued) {
          this.updateQueued = false;
          this.scheduleUpdate();
        }
      });
    }, 100); // Debounce interval set to 100ms
  }

  /**
   * Schedules an immediate price line update for real-time kline data.
   * This bypasses the debouncing mechanism for ultra-fast price line updates.
   */
  scheduleImmediatePriceUpdate() {
    // Clear any pending heatmap update timeout to avoid conflicts  
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
    }
    
    // Clear any pending immediate price update to avoid accumulation
    if (this.immediatePriceTimeout) {
      clearTimeout(this.immediatePriceTimeout);
    }
    
    // Schedule immediate price line update with minimal delay
    this.immediatePriceTimeout = setTimeout(() => {
      if (this.isRendering) {
        // If chart is currently rendering, try again very soon
        setTimeout(() => this.scheduleImmediatePriceUpdate(), 10);
        return;
      }
      
      this.isRendering = true;
      requestAnimationFrame(() => {
        // Only render chart without updating heatmap data for speed
        this.renderChart();
        this.isRendering = false;
      });
    }, 10); // Very fast update for price line (10ms instead of 100ms)
  }

  /**
   * Generates a new time slice for the heatmap from the current order book.
   */
  updateHeatmapData() {
    if (this.orderBook.bids.length === 0 || this.orderBook.asks.length === 0) return;

    this.orderBook.bids.sort((a, b) => b[0] - a[0]);
    this.orderBook.asks.sort((a, b) => a[0] - b[0]);

    const bestBid = this.orderBook.bids[0][0];
    const bestAsk = this.orderBook.asks[0][0];
    const midPrice = (bestBid + bestAsk) / 2;

    const priceRange = midPrice * this.options.priceRange;
    const minPrice = midPrice - priceRange;
    const maxPrice = midPrice + priceRange;
    const priceGrouping = this.options.priceGrouping;

    // Debug logging to inspect price range behaviour
    if (this.options.debug) {
      const startBucket = Math.floor(minPrice / priceGrouping) * priceGrouping;
      let count = 0;
      for (let p = startBucket; p <= maxPrice + 1e-12; p += priceGrouping) {
        count++;
        if (count > 100000) break; // safety
      }
      console.debug('PluginChartCOB priceRange debug', {
        midPrice,
        configuredPriceRange: this.options.priceRange,
        priceRange,
        minPrice,
        maxPrice,
        priceGrouping,
        startBucket,
        bucketCount: count
      });
      // Additional live-state debug info useful for price-line alignment
      console.debug('PluginChartCOB live state', {
        midPrice,
        currentKlinePrice: this.currentKlinePrice,
        lastPriceLine: this.priceLineHistory.length ? this.priceLineHistory[this.priceLineHistory.length - 1] : null,
        priceAxisLength: this.priceAxisData.length,
        lastTimeIndex: this.timeAxisData.length > 0 ? this.timeAxisData.length - 1 : null
      });
    }

    // Create price buckets for the Y-axis based on adaptive granularity
    this.priceAxisData = [];
    const startBucket = Math.floor(minPrice / priceGrouping) * priceGrouping;
    
    if (this.options.adaptiveGranularity && this.currentVWAP) {
      // Adaptive granularity: fine near VWAP, coarse away from it
      const vwapZoneMin = this.currentVWAP * (1 - this.options.vwapZoneRange);
      const vwapZoneMax = this.currentVWAP * (1 + this.options.vwapZoneRange);
      
      // Fine granularity in VWAP zone
      for (let p = startBucket; p <= maxPrice; p += priceGrouping) {
        if (p >= vwapZoneMin && p <= vwapZoneMax) {
          // Fine granularity near VWAP
          this.priceAxisData.push(p.toFixed(this.options.pricePrecision));
        } else {
          // Coarse granularity away from VWAP (every 3rd or 5th bucket)
          const coarseGrouping = priceGrouping * (Math.abs(p - this.currentVWAP) > this.currentVWAP * 0.008 ? 5 : 3);
          if (Math.abs(p - startBucket) % coarseGrouping < priceGrouping * 0.5) {
            this.priceAxisData.push(p.toFixed(this.options.pricePrecision));
          }
        }
      }
    } else {
      // Standard granularity when VWAP not available or adaptive disabled
      for (let p = startBucket; p <= maxPrice; p += priceGrouping) {
        this.priceAxisData.push(p.toFixed(this.options.pricePrecision));
      }
    }

    const now = new Date();
    const currentSecond = Math.floor(now.getTime() / 1000);
    let timeIndex;

    if (this.lastUpdateTime !== currentSecond) {
      // --- NEW SECOND: Add a new column ---
      this.lastUpdateTime = currentSecond;
      this.timeAxisData.push(`${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`);

      // Maintain exact maxHistory limit (not maxHistory + 1)
      while (this.timeAxisData.length > this.options.maxHistory) {
        this.timeAxisData.shift();
        // Shift all existing data points to the left for display data
        this.heatmapDataBids = this.heatmapDataBids
          .map(point => [point[0] - 1, point[1], point[2], point[3]]) // Include percentage in shift
          .filter(point => point[0] >= 0);
        this.heatmapDataAsks = this.heatmapDataAsks
          .map(point => [point[0] - 1, point[1], point[2], point[3]]) // Include percentage in shift
          .filter(point => point[0] >= 0);
        // Update labelData to shift with the time axis
        this.labelData = this.labelData
          .map(label => {
            label.value[0] -= 1; // Shift the time index
            return label;
          })
          .filter(label => label.value[0] >= 0); // Remove labels that are out of range
        
        // Shift VWAP history data to align with time axis
        this.vwapHistory = this.vwapHistory
          .map(([time, vwap]) => [time - 1, vwap])
          .filter(([time]) => time >= 0);
        
        // Shift price line history to align with time axis
        this.priceLineHistory = this.priceLineHistory
          .map(([time, price]) => [time - 1, price])
          .filter(([time]) => time >= 0);
      }

      // Separately manage heatmap data storage limit (can be larger than display limit)
      while (this.timeAxisData.length > this.options.maxHeatmapHistory) {
        // Clean up excess heatmap data beyond storage limit
        const excessCount = this.timeAxisData.length - this.options.maxHeatmapHistory;
        this.heatmapDataBids = this.heatmapDataBids.filter(point => point[0] >= excessCount);
        this.heatmapDataAsks = this.heatmapDataAsks.filter(point => point[0] >= excessCount);
        // This should not normally execute since maxHeatmapHistory >= maxHistory
        break; // Safety break to prevent infinite loop
      }
    }
    
    timeIndex = this.timeAxisData.length - 1;
    
    // Store the previous price axis for comparison
    const previousPriceAxisLength = this.priceAxisData.length;
    const previousMinPrice = this.priceAxisData.length > 0 ? parseFloat(this.priceAxisData[0]) : null;
    const previousMaxPrice = this.priceAxisData.length > 0 ? parseFloat(this.priceAxisData[this.priceAxisData.length - 1]) : null;
    
    // Always remove the last column's data before recalculating to prevent accumulation.
    this.heatmapDataBids = this.heatmapDataBids.filter(point => point[0] !== timeIndex);
    this.heatmapDataAsks = this.heatmapDataAsks.filter(point => point[0] !== timeIndex);
    
    // Check if the price axis has changed significantly (price range moved)
    const currentMinPrice = parseFloat(this.priceAxisData[0]);
    const currentMaxPrice = parseFloat(this.priceAxisData[this.priceAxisData.length - 1]);
    const priceAxisChanged = previousMinPrice !== null && (
      Math.abs(currentMinPrice - previousMinPrice) > priceGrouping ||
      Math.abs(currentMaxPrice - previousMaxPrice) > priceGrouping ||
      this.priceAxisData.length !== previousPriceAxisLength
    );
    
    // If price axis changed significantly, clean up old data that may reference invalid price indices
    if (priceAxisChanged) {
      // Filter out data points that reference price indices outside the current range
      const maxPriceIndex = this.priceAxisData.length - 1;
      this.heatmapDataBids = this.heatmapDataBids.filter(point => point[1] >= 0 && point[1] <= maxPriceIndex);
      this.heatmapDataAsks = this.heatmapDataAsks.filter(point => point[1] >= 0 && point[1] <= maxPriceIndex);
      
      // Also clean up tracked levels that may reference old price indices
      Object.keys(this.trackedLevels.bids).forEach(priceIdxStr => {
        const priceIndex = parseInt(priceIdxStr, 10);
        if (priceIndex < 0 || priceIndex > maxPriceIndex) {
          delete this.trackedLevels.bids[priceIndex];
        }
      });
      
      Object.keys(this.trackedLevels.asks).forEach(priceIdxStr => {
        const priceIndex = parseInt(priceIdxStr, 10);
        if (priceIndex < 0 || priceIndex > maxPriceIndex) {
          delete this.trackedLevels.asks[priceIndex];
        }
      });
      
      // Clean up label data that references invalid price indices
      this.labelData = this.labelData.filter(label => {
        const priceIndex = label.value[1];
        return priceIndex >= 0 && priceIndex <= maxPriceIndex;
      });
    }

    const processSide = (side, heatmapData, trackedSide, isBid = true) => {
  // Use numeric mid price for partitioning so axis inversion doesn't swap sides
  const midPriceFloat = midPrice;
      // --- Reset trackedSide for price indices not present in current priceAxisData ---
      const validPriceIndices = new Set(this.priceAxisData.map((_, idx) => idx));
      Object.keys(trackedSide).forEach(priceIdxStr => {
        const priceIndex = parseInt(priceIdxStr, 10);
        if (!validPriceIndices.has(priceIndex)) {
          delete trackedSide[priceIndex];
        }
      });

      // --- Remove labels for price indices not present in current priceAxisData ---
      // (But do NOT remove labels just because the tracked level temporarily drops below threshold)
      // Only remove labels if the price index is no longer valid (out of range)
      this.labelData = this.labelData.filter(label => {
        const priceIndex = label.value[1];
        return validPriceIndices.has(priceIndex);
      });

      // --- Calculate volume for the current moment ---
      const currentVolumes = new Map();
      this.priceAxisData.forEach((bucketStartStr, priceIndex) => {
        const bucketStart = parseFloat(bucketStartStr);
        const bucketEnd = bucketStart + priceGrouping;
        // Partition by numeric price relative to midPrice: bids < midPrice, asks >= midPrice
        if (isBid && bucketStart >= midPriceFloat) return;
        if (!isBid && bucketStart < midPriceFloat) return;
        const volume = side
          .filter(([p]) => p >= bucketStart && p < bucketEnd)
          .reduce((sum, [, q]) => sum + q, 0);
        if (volume > 0) {
          currentVolumes.set(priceIndex, volume);
        }
      });

      // --- Calculate total volume for percentage calculations ---
      const totalVolume = Array.from(currentVolumes.values()).reduce((sum, vol) => sum + vol, 0);

      // --- Process volumes with percentage calculations and adaptive filtering ---
      // Ensure no percentage is ever 0%: set a minimum floor of 0.1%
      const PERCENTAGE_FLOOR = 0.1;
      currentVolumes.forEach((volume, priceIndex) => {
        const percentage = totalVolume > 0 ? Math.max((volume / totalVolume) * 100, PERCENTAGE_FLOOR) : PERCENTAGE_FLOOR;
        const priceLevel = parseFloat(this.priceAxisData[priceIndex]);

        // Apply adaptive filtering based on distance from VWAP
        let showLevel = true;
        if (this.options.adaptiveGranularity && this.currentVWAP) {
          const vwapZoneMin = this.currentVWAP * (1 - this.options.vwapZoneRange);
          const vwapZoneMax = this.currentVWAP * (1 + this.options.vwapZoneRange);
          if (priceLevel < vwapZoneMin || priceLevel > vwapZoneMax) {
            showLevel = percentage >= this.options.distantWallThreshold;
          }
        }

        if (!showLevel) return;

        // Update or add to tracked levels if volume is significant (based on percentage threshold)
        if (percentage > this.options.percentageThresholdForLabel) {
          // Only create textual labels when the raw volume exceeds configured minimum
          const shouldLabel = volume >= (this.options.labelMinVolume !== undefined ? this.options.labelMinVolume : 0);
          if (shouldLabel && !trackedSide[priceIndex]?.hasLabel) {
            // Show actual volume, use 'k' only if >= 1000
            let labelText;
            if (this.options.showPercentageInLabels) {
              if (volume >= 1000) {
                labelText = isBid
                  ? `+${(volume/1000).toFixed(1)}k (${percentage.toFixed(1)}%)`
                  : `-${(volume/1000).toFixed(1)}k (${percentage.toFixed(1)}%)`;
              } else {
                labelText = isBid
                  ? `+${Number(volume).toFixed(0)} (${percentage.toFixed(1)}%)`
                  : `-${Number(volume).toFixed(0)} (${percentage.toFixed(1)}%)`;
              }
            } else {
              if (volume >= 1000) {
                labelText = isBid
                  ? `+${(volume/1000).toFixed(1)}k`
                  : `-${(volume/1000).toFixed(1)}k`;
              } else {
                labelText = isBid
                  ? `+${Number(volume).toFixed(0)}`
                  : `-${Number(volume).toFixed(0)}`;
              }
            }
            const newLabel = {
              value: [timeIndex, priceIndex, volume, labelText]
            };
            this.labelData.push(newLabel);
            // Mark tracked level as having an associated label
            trackedSide[priceIndex] = trackedSide[priceIndex] || {};
            trackedSide[priceIndex].hasLabel = true;
          } else if (shouldLabel && trackedSide[priceIndex]?.hasLabel) {
            // If label already exists, we still update tracking metadata below
          }
          trackedSide[priceIndex] = trackedSide[priceIndex] || {};
          trackedSide[priceIndex].volume = volume;
          trackedSide[priceIndex].percentage = percentage;
          trackedSide[priceIndex].lastSeen = timeIndex;
          trackedSide[priceIndex].startTime = trackedSide[priceIndex]?.startTime ?? timeIndex;
        } else if (trackedSide[priceIndex]) {
          // If the tracked level is still present but volume dropped below threshold, update its volume/percentage/lastSeen
          trackedSide[priceIndex].volume = volume;
          trackedSide[priceIndex].percentage = percentage;
          trackedSide[priceIndex].lastSeen = timeIndex;
        }
      });

      // --- Carry forward persistent levels and clean up old ones ---
      Object.keys(trackedSide).forEach(priceIdxStr => {
        const priceIndex = parseInt(priceIdxStr, 10);
        const level = trackedSide[priceIndex];
        // Do NOT remove label if tracked level is gone for too long; labels are persistent unless price index is out of range
        // If the level is not in the current update, "ghost" it to keep the line solid
        if (!currentVolumes.has(priceIndex)) {
          const priceLevel = parseFloat(this.priceAxisData[priceIndex]);
          // Respect partitioning for ghost levels as well (numeric price-based)
          if (isBid && priceLevel >= midPriceFloat) return;
          if (!isBid && priceLevel < midPriceFloat) return;
          let showGhostLevel = true;
          if (this.options.adaptiveGranularity && this.currentVWAP) {
            const vwapZoneMin = this.currentVWAP * (1 - this.options.vwapZoneRange);
            const vwapZoneMax = this.currentVWAP * (1 + this.options.vwapZoneRange);
            if (priceLevel < vwapZoneMin || priceLevel > vwapZoneMax) {
              showGhostLevel = level.percentage >= this.options.distantWallThreshold;
            }
          }
          if (showGhostLevel) {
            currentVolumes.set(priceIndex, level.volume);
          }
        }
      });

      // --- Add the final calculated volumes and percentages for this time slice to the heatmap data ---
      // Recompute totalVolume in case ghost levels were added above, and apply the same floor
      const finalTotalVolume = Array.from(currentVolumes.values()).reduce((sum, vol) => sum + vol, 0);
      currentVolumes.forEach((volume, priceIndex) => {
        const percentage = finalTotalVolume > 0 ? Math.max((volume / finalTotalVolume) * 100, PERCENTAGE_FLOOR) : PERCENTAGE_FLOOR;
        if (this.options.debug && percentage <= PERCENTAGE_FLOOR + 1e-12) {
          // Log symbol, timeIndex, priceIndex, volume and percentage when floor is hit
          console.debug('PluginChartCOB: percentage floor hit', { symbol: this.options.symbol, timeIndex, priceIndex, volume, percentage });
        }
        heatmapData.push([timeIndex, priceIndex, volume, percentage]);
      });
    };

    processSide(this.orderBook.bids, this.heatmapDataBids, this.trackedLevels.bids, true); // true for bids
    processSide(this.orderBook.asks, this.heatmapDataAsks, this.trackedLevels.asks, false); // false for asks
    
    // Update price line with current mid-price (synchronized with heatmap)
    this.updatePriceLine(midPrice, timeIndex);
    
    // Calculate and update VWAP
    this.updateVWAP();
  }

  /**
   * Calculates and updates the Volume Weighted Average Price (VWAP).
   * VWAP = Sum(Price * Volume) / Sum(Volume)
   */
  updateVWAP() {
    if (this.orderBook.bids.length === 0 || this.orderBook.asks.length === 0) return;

    // Initialize VWAP start time if not set
    if (!this.vwapStartTime) {
      this.vwapStartTime = Date.now();
    }

    // Calculate current period's price-volume data using mid-price for more stable VWAP
    const bestBid = this.orderBook.bids[0][0];
    const bestAsk = this.orderBook.asks[0][0];
    const midPrice = (bestBid + bestAsk) / 2;
    
    // Calculate total volume for this period
    let periodVolume = 0;
    [...this.orderBook.bids, ...this.orderBook.asks].forEach(([price, volume]) => {
      periodVolume += volume;
    });

    // Use mid-price as the representative price for this period's volume
    const periodPriceVolume = midPrice * periodVolume;

    // Update cumulative values
    this.cumulativePriceVolume += periodPriceVolume;
    this.cumulativeVolume += periodVolume;

    // Calculate current VWAP
    const currentVWAP = this.cumulativeVolume > 0 ? this.cumulativePriceVolume / this.cumulativeVolume : midPrice;
    this.currentVWAP = currentVWAP; // Store for adaptive granularity calculations

    // Add to VWAP history
    const timeIndex = this.timeAxisData.length - 1;
    
    // Only add VWAP data if we have sufficient data points and valid price range
    if (this.vwapHistory.length >= this.options.minDataPointsForVWAP && this.priceAxisData.length > 0) {
      this.vwapHistory.push([timeIndex, currentVWAP]);
    } else if (this.priceAxisData.length > 0) {
      // Still building up data, add to history but don't display yet
      this.vwapHistory.push([timeIndex, currentVWAP]);
    }

    // Keep VWAP history aligned with display history (use maxHistory for display)
    while (this.vwapHistory.length > this.options.maxHistory) {
      this.vwapHistory.shift();
    }

    // Convert VWAP to price axis index for visualization only if we have enough data
    if (this.priceAxisData.length > 0 && currentVWAP > 0 && this.vwapHistory.length >= this.options.minDataPointsForVWAP) {
      const minPrice = parseFloat(this.priceAxisData[0]);
      const maxPrice = parseFloat(this.priceAxisData[this.priceAxisData.length - 1]);
      
      // Only show VWAP if it's within the visible price range
      if (currentVWAP >= minPrice && currentVWAP <= maxPrice) {
        // Find the closest price bucket for VWAP with better precision
        let closestIndex = 0;
        let closestDistance = Math.abs(currentVWAP - parseFloat(this.priceAxisData[0]));
        
        for (let i = 1; i < this.priceAxisData.length; i++) {
          const priceAtIndex = parseFloat(this.priceAxisData[i]);
          const distance = Math.abs(currentVWAP - priceAtIndex);
          if (distance < closestDistance) {
            closestDistance = distance;
            closestIndex = i;
          }
        }
        
        this.vwapData = [[timeIndex, closestIndex, currentVWAP]];
      } else {
        // VWAP is outside visible range, don't display
        this.vwapData = [];
      }
    } else {
      // Not enough data yet, don't display VWAP
      this.vwapData = [];
    }
  }

  /**
   * Renders or updates the ECharts heatmap instance with optimized performance.
   */
  renderChart() {
    if (!this.chartInstance) return;

    const chartOptions = this.generateChartOptions();
    
    // Use safer merging to avoid transient missing series models (prevents getRawIndex errors)
    this.chartInstance.setOption(chartOptions, {
      notMerge: false, // Allow echarts to merge new options into existing model
      silent: false,
      lazyUpdate: true
    });
  }

  /**
   * Generates the chart options object.
   */
  generateChartOptions() {
    // Helper to shade a hex color by percent (negative = darker, positive = lighter)
    function shadeColor(color, percent) {
      let R = parseInt(color.substring(1,3),16);
      let G = parseInt(color.substring(3,5),16);
      let B = parseInt(color.substring(5,7),16);
      R = Math.min(255, Math.max(0, R + Math.round(255 * percent / 100)));
      G = Math.min(255, Math.max(0, G + Math.round(255 * percent / 100)));
      B = Math.min(255, Math.max(0, B + Math.round(255 * percent / 100)));
      return `#${R.toString(16).padStart(2,'0')}${G.toString(16).padStart(2,'0')}${B.toString(16).padStart(2,'0')}`;
    }

    // Handle case where no data exists yet
    if (!this.heatmapDataBids || this.heatmapDataBids.length === 0) {
      this.heatmapDataBids = [];
    }
    if (!this.heatmapDataAsks || this.heatmapDataAsks.length === 0) {
      this.heatmapDataAsks = [];
    }
    
    // If no time axis data yet, create minimal structure for empty chart
    if (this.timeAxisData.length === 0) {
      return {
        title: {
          text: `Order Book Heatmap with VWAP - ${this.options.symbol} (Waiting for data...)`,
          left: 'center',
          textStyle: { color: '#000' }
        },
        grid: {
          left: '10%',
          right: '5%',
          bottom: '15%',
          top: '10%',
          backgroundColor: '#ffffff',
          borderColor: '#ccc',
          borderWidth: 1,
          containLabel: true
        },
        xAxis: [
          {
            type: 'category',
            data: [],
            splitLine: { show: true, lineStyle: { color: '#ddd', type: 'dashed' } },
            axisLine: { show: false },
            axisLabel: { color: '#333', interval: 'auto' }
          },
          {
            type: 'category',
            data: [],
            show: false,
            splitLine: { show: false },
            axisLine: { show: false }
          }
        ],
        yAxis: [
          {
            type: 'category',
            data: [],
            position: 'right',
            splitLine: { show: true, lineStyle: { color: '#ddd' } },
            inverse: false,
            axisLine: { show: false },
            axisLabel: { color: '#333' }
          },
          {
            type: 'value',
            show: false,
            min: 1, // Reversed for empty case
            max: 0,
            splitLine: { show: false },
            axisLine: { show: false }
          }
        ],
  series: [],
  backgroundColor: '#ffffff'
      };
    }

    // Calculate percentage-based colors for bids and asks
    const calculatePercentageBasedColors = (data, colors) => {
  const lowThreshold = this.options.percentageThresholdColorVariance;
  const highThreshold = this.options.maxPercentageThresholdColorVariance;
      const len = this.priceAxisData.length;

      return data.map(([timeIndex, priceIndex, volume, percentage]) => {
        let color;
        // If percentage is zero or falsy, render the wall as white
        if (!Number.isFinite(percentage) || percentage <= 0 || !percentage) {
          color = '#ffffff';
        } else if (percentage < lowThreshold) {
          const colorIndex = Math.floor((percentage / lowThreshold) * 3);
          color = colors[Math.max(0, Math.min(colors.length - 1, colorIndex))];
        } else if (percentage <= highThreshold) {
          const colorIndex = 3 + Math.floor(((percentage - lowThreshold) / (highThreshold - lowThreshold)) * (colors.length - 3));
          color = colors[Math.max(0, Math.min(colors.length - 1, colorIndex))];
        } else {
          color = colors[colors.length - 1];
        }
  // Convert internal priceIndex (0=min) to display index (no flip)
  const displayIndex = Math.max(0, Math.min(len - 1, priceIndex));
        return [timeIndex, displayIndex, volume, color, percentage];
      });
    };

    // Helper function to interpolate between two hex colors
    const interpolateColor = (color1, color2, factor) => {
      // Convert hex to RGB
      const hex1 = color1.replace('#', '');
      const hex2 = color2.replace('#', '');
      
      const r1 = parseInt(hex1.substr(0, 2), 16);
      const g1 = parseInt(hex1.substr(2, 2), 16);
      const b1 = parseInt(hex1.substr(4, 2), 16);
      
      const r2 = parseInt(hex2.substr(0, 2), 16);
      const g2 = parseInt(hex2.substr(2, 2), 16);
      const b2 = parseInt(hex2.substr(4, 2), 16);
      
      // Interpolate
      const r = Math.round(r1 + (r2 - r1) * factor);
      const g = Math.round(g1 + (g2 - g1) * factor);
      const b = Math.round(b1 + (b2 - b1) * factor);
      
      // Convert back to hex
      return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    };

    // Bid clay colors aligned in the Green color wheel (from lightest to darkest, smooth progression)
    // Description: light white/green to bright orange/red for bids (clay wall look)
    const bidclayColors = [
      '#eafffb', // almost white green (lowest volume)
      '#b5ff8a', // pale neon green
      '#86ff5a', // neon green
      '#63de4aff', // light green
      '#22c52dff', // vivid green
      '#267c15ff', // medium green
      '#145314ff', // dark green
      '#033502ff'  // very dark blue-green (highest volume)
    ];

    // Ask clay colors aligned in the orange color wheel (from lightest to darkest, smooth progression)
    // Description: light tan/yellow to deep orange/red for asks (clay wall look)
    const askclayColors = [
      '#fffbe6', // very light tan/yellow (lowest volume)
      '#ffe0b2', // light orange
      '#ffb74d', // medium orange
      '#ff9800', // vivid orange
      '#ff7043', // orange-red
      '#ff3d00', // strong red-orange
      '#d84315', // deep orange-red
      '#a93226'  // darkest clay red (highest volume)
    ];
    
    // Use same clay color gradient for both bids and asks for a unified clay wall look
    const coloredBidsData = calculatePercentageBasedColors(this.heatmapDataBids, bidclayColors);
    const coloredAsksData = calculatePercentageBasedColors(this.heatmapDataAsks, askclayColors);

    // Map labelData to display indices so labels land at correct visual rows
    const mappedLabelData = (this.labelData || []).map(label => {
      const len = this.priceAxisData.length;
      const origIdx = label.value[1];
  const displayIdx = Math.max(0, Math.min(len - 1, origIdx));
      return { value: [label.value[0], displayIdx, label.value[2], label.value[3]] };
    });

    return {
      title: {
        text: `Order Book Heatmap with VWAP${this.options.enablePriceLine ? (this.klineWebSocketUrl ? ' & Real-time Price Line' : ' & Price Line') : ''} - ${this.options.symbol}`,
        left: 'center',
        textStyle: { color: '#000' }
      },
      tooltip: {
        position: 'top',
        formatter: (params) => {
          const volume = params.value[2];
          const percentage = params.value[4] || 0;
          // params.value[1] is displayIndex; convert back to original index to find price
          const len = this.priceAxisData.length;
          const origIndex = Math.max(0, Math.min(len - 1, params.value[1]));
          const priceLabel = this.priceAxisData[origIndex] || 'N/A';
          return `Price: ${priceLabel}<br/>Volume: ${volume.toFixed(2)}<br/>Percentage: ${percentage.toFixed(2)}%`;
        },
      },
      grid: {
        left: '10%',
        right: '5%',
        bottom: '15%',
        top: '10%',
        backgroundColor: '#ffffff',
        borderColor: '#ccc',
        borderWidth: 1,
        containLabel: true
      },
      xAxis: [
        {
          // Primary X-axis for heatmap (seconds)
          type: 'category',
          data: this.timeAxisData,
          splitLine: { show: true, lineStyle: { color: '#ddd', type: 'dashed' } },
          axisLine: { show: false },
          axisLabel: { 
            color: '#333', 
            interval: 5, // Show every 5th label (every 5 seconds for 2-minute window)
            rotate: 0,
            fontSize: 10
          }
        },
        {
          // Secondary X-axis for price line (same as heatmap - hidden)
          type: 'category',
          data: this.timeAxisData, // Use same time data as heatmap for perfect alignment
          show: false, // Hide this axis - no need to show it for price line
          splitLine: { show: false },
          axisLine: { show: false },
          axisLabel: { show: false }
        }
      ],
    yAxis: [
        {
          // Primary Y-axis for heatmap (price buckets as categories)
          type: 'category',
          data: this.priceAxisData,
          position: 'right',
      splitLine: { show: true, lineStyle: { color: '#ddd' } },
    inverse: false,
      axisLine: { show: false },
      axisLabel: { color: '#333' }
        },
        {
          // Secondary Y-axis for price line (actual price values) - hidden
          type: 'value',
          show: false, // Hide this axis
          min: this.priceAxisData.length > 0 ? parseFloat(this.priceAxisData[0]) : 0, // Min is the LOWEST price (priceAxisData[0])
          max: this.priceAxisData.length > 0 ? parseFloat(this.priceAxisData[this.priceAxisData.length - 1]) : 1, // Max is the HIGHEST price (priceAxisData[last])
          // Invert numeric axis so it shares the same vertical orientation as
          // the heatmap category axis (prevents price line appearing flipped).
          inverse: true,
          splitLine: { show: false },
          axisLine: { show: false }
        }
      ],

      series: [
        { // Bids Series
          name: 'Bids',
          type: 'heatmap',
          animation: true, // Enable animation for smooth heatmap transitions
          animationDuration: 600,
          animationEasing: 'cubicOut',
          xAxisIndex: 0, // Use primary X-axis (heatmap time axis)
          yAxisIndex: 0, // Use primary Y-axis (heatmap price axis)
          data: coloredBidsData,
          itemStyle: {
            color: (params) => {
              // Use clay color as base, but return solid white for explicit white baseColor
              const baseColorRaw = params.data[3] || '#3e2723';
              const baseColor = (typeof baseColorRaw === 'string' ? baseColorRaw : String(baseColorRaw)).toLowerCase();
              // If color was set to white for zero-volume, return solid white to avoid dark shaded edges
              if (baseColor === '#ffffff' || baseColor === '#fff') {
                return '#ffffff';
              }
              // ECharts linearGradient: left to right, darken at edges
              return {
                type: 'linear',
                x: 0, y: 0, x2: 1, y2: 1,
                colorStops: [
                  { offset: 0, color: shadeColor(baseColorRaw, -30) }, // left/top edge darker
                  { offset: 0.15, color: shadeColor(baseColorRaw, -10) },
                  { offset: 0.5, color: baseColorRaw }, // center
                  { offset: 0.85, color: shadeColor(baseColorRaw, -10) },
                  { offset: 1, color: shadeColor(baseColorRaw, -30) } // right/bottom edge darker
                ]
              };
            },
            borderRadius: 0,
            borderWidth: 0,
            opacity: 1
          },
          emphasis: {
            itemStyle: {
              shadowBlur: 3,
              shadowColor: 'rgba(0, 255, 0, 0.3)' // Green glow on hover for bids
            }
          },
          label: { show: false },
        },
        { // Asks Series
          name: 'Asks',
          type: 'heatmap',
          animation: true, // Enable animation for smooth heatmap transitions
          animationDuration: 600,
          animationEasing: 'cubicOut',
          xAxisIndex: 0, // Use primary X-axis (heatmap time axis)
          yAxisIndex: 0, // Use primary Y-axis (heatmap price axis)
          data: coloredAsksData,
          itemStyle: {
            color: (params) => {
              const baseColorRaw = params.data[3] || '#3e2723';
              const baseColor = (typeof baseColorRaw === 'string' ? baseColorRaw : String(baseColorRaw)).toLowerCase();
              if (baseColor === '#ffffff' || baseColor === '#fff') {
                return '#ffffff';
              }
              return {
                type: 'linear',
                x: 0, y: 0, x2: 1, y2: 1,
                colorStops: [
                  { offset: 0, color: shadeColor(baseColorRaw, -30) },
                  { offset: 0.15, color: shadeColor(baseColorRaw, -10) },
                  { offset: 0.5, color: baseColorRaw },
                  { offset: 0.85, color: shadeColor(baseColorRaw, -10) },
                  { offset: 1, color: shadeColor(baseColorRaw, -30) }
                ]
              };
            },
            borderRadius: 0,
            borderWidth: 0,
            opacity: 1
          },
          emphasis: {
            itemStyle: {
              shadowBlur: 3,
              shadowColor: 'rgba(255, 0, 0, 0.3)' // Red glow on hover for asks
            }
          },
          label: { show: false }, // Turn off default heatmap labels
        },
        { // Persistent Labels Series
          name: 'Labels',
          type: 'scatter',
          animation: false, // Disable animation for better performance
          xAxisIndex: 0, // Use primary X-axis (heatmap time axis)
          yAxisIndex: 0, // Use primary Y-axis (heatmap price axis)
          coordinateSystem: 'cartesian2d', // Explicitly use the cartesian coordinate system
          data: mappedLabelData,
          symbolSize: 1, // Very small but visible points (required for labels to render)
          itemStyle: {
            color: 'transparent', // Make the actual scatter points transparent
            borderColor: 'transparent'
          },
          label: {
            show: true,
            position: 'inside',
            color: '#000',
            backgroundColor: '#fff',
            borderRadius: 3,
            padding: [2, 4],
            fontSize: 16,
            fontWeight: 'bold',
            formatter: (params) => params.value[3] // Use the 4th element in value array for the label
          }
        },
        { // VWAP Line Series
          name: 'VWAP',
            type: 'line',
            animation: true, // Enable animation for smooth sweeping
            smooth: true, // Enable smooth line for sweeping effect
            xAxisIndex: 1, // Use secondary X-axis (aligned with price line and hidden)
            yAxisIndex: 1, // Use secondary Y-axis (value axis) so VWAP is plotted using actual price
            coordinateSystem: 'cartesian2d',
            data: this.vwapHistory.length >= this.options.minDataPointsForVWAP ? 
              this.vwapHistory
                .filter(([timeIndex, vwap]) => {
                  // Only include points where VWAP is within the visible price range
                  if (this.priceAxisData.length === 0) return false;
                  const minPrice = parseFloat(this.priceAxisData[0]);
                  const maxPrice = parseFloat(this.priceAxisData[this.priceAxisData.length - 1]);
                  return vwap >= minPrice && vwap <= maxPrice;
                })
                .map(([timeIndex, vwap]) => {
                  // Plot VWAP using the actual price value on the value-based Y axis
                  return [timeIndex, vwap];
                }) : 
              [], // Show empty data if not enough points yet
          lineStyle: {
            color: '#e7ddbf', // Gold color for VWAP line (6-digit hex)
            width: 4,
            type: 'dashed', // Dashed line style
            opacity: this.vwapHistory.length >= this.options.minDataPointsForVWAP ? 1 : 0, // Fade in when ready
            shadowColor: this.options.vwapLineGlowColor || '#333333',
            shadowBlur: this.options.vwapLineGlowBlur || 18,
            shadowOffsetY: 0,
            shadowOffsetX: 0
          },
          symbol: 'none', // No symbols on the line points
          tooltip: {
            formatter: (params) => {
              const vwapValue = this.vwapHistory[params.dataIndex] ? this.vwapHistory[params.dataIndex][1] : 0;
              return `VWAP: ${vwapValue.toFixed(4)} (${this.vwapHistory.length} data points)`;
            }
          }
        }
      ].concat(this.getPriceLineSeries()), // Add price line series if enabled
  backgroundColor: '#ffffff'
    };
  }

  /**
   * Generates price line series if enabled and data is available.
   * Simple line showing mid-price over time, perfectly synchronized with heatmap.
   * @returns {Array} Array containing price line series or empty array
   */
  getPriceLineSeries() {
    if (!this.options.enablePriceLine || this.priceLineHistory.length === 0 || this.priceAxisData.length === 0) {
      return [];
    }

    // Only show price line after heatmap has at least 2 seconds of data
    if (this.timeAxisData.length < 2) {
      return [];
    }

    // Get price range for filtering
    const maxPrice = parseFloat(this.priceAxisData[this.priceAxisData.length - 1]);
    const minPrice = parseFloat(this.priceAxisData[0]);

    // Filter price line points that are within the visible price range
    const visiblePricePoints = this.priceLineHistory
      .filter(([timeIndex, price]) => price >= minPrice && price <= maxPrice)
      .map(([timeIndex, price]) => [timeIndex, price]);

    if (visiblePricePoints.length === 0) {
      if (this.options.debug) {
        console.debug('PluginChartCOB: getPriceLineSeries - no visible price points', {
          priceLineHistoryLength: this.priceLineHistory.length,
          minPrice,
          maxPrice,
          lastPriceLine: this.priceLineHistory.length ? this.priceLineHistory[this.priceLineHistory.length - 1] : null
        });
      }
      return [];
    }

    const priceLineSeries = [{
      name: 'Price Line',
      type: 'line',
      animation: true, // Enable animation for smooth sweeping
      smooth: true, // Enable smooth line for sweeping effect
      xAxisIndex: 1, // Use secondary X-axis (same as heatmap)
      yAxisIndex: 1, // Use secondary Y-axis for price positioning
      data: visiblePricePoints,
      lineStyle: {
        color: this.options.priceLineColor,
        width: this.options.priceLineWidth,
        opacity: this.options.priceLineOpacity,
        shadowColor: this.options.priceLineGlowColor || '#ffff80',
        shadowBlur: this.options.priceLineGlowBlur || 18,
        shadowOffsetY: 0,
        shadowOffsetX: 0
      },
      symbol: 'none', // No symbols on the line points
      tooltip: {
        formatter: (params) => {
          const price = params.data[1];
          const timeIndex = params.data[0];
          const timeLabel = this.timeAxisData[timeIndex] || 'Unknown';
          return `Price: ${price.toFixed(4)}<br/>Time: ${timeLabel}<br/>Time Index: ${timeIndex}`;
        }
      }
    }];

    return priceLineSeries;
  }

  /**
   * Handles window resize events to make the chart responsive.
   */
  resize() {
    if (this.chartInstance) {
      this.chartInstance.resize();
    }
  }
}

