class PluginChartCandlesVolume {
  // Utility to sanitize color values for ECharts
  sanitizeColor(c) {
    if (!c || c === 'none' || c === null) return 'transparent';
    return c;
  }
  constructor(options = {}) {
    this.options = options;
    this.pluginSeriesData = {};
    this.colorPalette = ["#FF0000", "#00FF00", "#0000FF", "#800080", "#FFA500", "#FFFF00", "#008080", "#000000"];
    this.indicatorKeys = ["prevAlphaTrend", "currentAlphaTrend", "ma200"];
    this.yAxisMin = options.yAxisMin || 'dataMin';
    this.yAxisMax = options.yAxisMax || 'dataMax';
    this.maxVisiblePoints = options.maxVisiblePoints || 30;
    this.containerId = options.containerId || 'pluginChart';
    this.chartInstance = null;
    this.signalMarkers = [];
    this.markLines = options.markLines || [];
    this.candlestickData = { categoryData: [], values: [] };
    this.klineWebSocketUrl = options.klineWebSocketUrl || null;
    this.storageKey = `PluginChartState_${this.containerId}_${options.symbol || 'defaultSymbol'}`;
    this.persistenceEnabled = true;
    this.buyActionsData = [];
    this.sellActionsData = [];
    this.plotTrades = [];
    this.animationSpeed = typeof options.animationSpeed === 'number' ? options.animationSpeed : 200; // Default to 200ms per frame
    this.dataRetentionMinutes = 30; // Default

    if (this.klineWebSocketUrl) {
      const limitMatch = this.klineWebSocketUrl.match(/[\?&]limit=(\d+)/);
      if (limitMatch && limitMatch[1]) {
        this.dataRetentionMinutes = parseInt(limitMatch[1], 10);
      }
    }

    this.maxWalls = typeof options.maxWalls === 'number' ? options.maxWalls : 180;

    // wallPctRange: wallPctRange controls how far a wall can be from the current price to be considered relevant.

    // Example: For a price of $3.00, 0.1% range is $3.00 ± ($3.00 * 0.001) = $2.997 to $3.003
    // Example: For a price of $3.00, 0.2% range is $3.00 ± ($3.00 * 0.002) = $2.994 to $3.006
    // Example: For a price of $3.00, 0.3% range is $3.00 ± ($3.00 * 0.003) = $2.991 to $3.009
    // Example: For a price of $3.00, 0.4% range is $3.00 ± ($3.00 * 0.004) = $2.988 to $3.012
    this.wallPctRange = options.wallPctRange || 0.7; // 0.7%

    // wallReplacePctRange: wallReplacePctRange controls when a new wall replaces an existing wall (based on similarity).
    this.wallReplacePctRange = typeof options.wallReplacePctRange === 'number' ? options.wallReplacePctRange : 1; // 1 percent
    this.normalizeWallsGlobally = options.normalizeWallsGlobally ?? false;

  }

  loadState() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;

      const { timestamp, pluginSeriesData, signalMarkers, markLines, buyActionsData, sellActionsData } = JSON.parse(raw);

      if (timestamp) {
        const dataAgeMinutes = (new Date().getTime() - timestamp) / (1000 * 60);
        if (dataAgeMinutes > this.dataRetentionMinutes) {
          console.log(`PluginChart: Stored data is older than ${this.dataRetentionMinutes} minutes. Clearing state.`);
          this.clearState();
          return;
        }
      }

      if (pluginSeriesData) this.pluginSeriesData = pluginSeriesData;
      if (signalMarkers) this.signalMarkers = signalMarkers;
      if (markLines) this.markLines = markLines;
      if (buyActionsData) this.buyActionsData = buyActionsData;
      if (sellActionsData) this.sellActionsData = sellActionsData;

      console.log('PluginChart: Restored state from localStorage.');
      /*for (const pluginName in this.pluginSeriesData) {
        console.debug(`PluginChart: Restored walls for ${pluginName}:`, {
          sellWalls: this.pluginSeriesData[pluginName]?.sellWalls,
          buyWalls: this.pluginSeriesData[pluginName]?.buyWalls
        });
      }*/
    } catch (err) {
      console.warn('PluginChart: failed to load state:', err);
    }
  }

  saveState() {
    if (!this.persistenceEnabled) return;

    /*for (const pluginName in this.pluginSeriesData) {
      console.debug(`PluginChart: Saving walls for ${pluginName}:`, {
        sellWalls: this.pluginSeriesData[pluginName]?.sellWalls,
        buyWalls: this.pluginSeriesData[pluginName]?.buyWalls
      });
    }*/

    const payload = JSON.stringify({
      timestamp: new Date().getTime(),
      pluginSeriesData: this.pluginSeriesData,
      signalMarkers: this.signalMarkers,
      markLines: this.markLines,
      buyActionsData: this.buyActionsData,
      sellActionsData: this.sellActionsData
    });

    try {
      localStorage.setItem(this.storageKey, payload);
    } catch (err) {
      const isQuotaExceeded = (
        err instanceof DOMException &&
        (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED')
      );

      if (isQuotaExceeded) {
        console.warn('PluginChart: storage quota exceeded, dropping oldest data and retrying');
        this.cleanupOldestData();

        try {
          const reducedPayload = JSON.stringify({
            pluginSeriesData: this.pluginSeriesData,
            signalMarkers: this.signalMarkers,
            markLines: this.markLines,
            buyActionsData: this.buyActionsData,
            sellActionsData: this.sellActionsData
          });
          localStorage.setItem(this.storageKey, reducedPayload);
        } catch (err2) {
          console.error('PluginChart: retry failed, disabling persistence', err2);
          this.persistenceEnabled = false;
        }
      } else {
        console.error('PluginChart: unexpected saveState error:', err);
        this.persistenceEnabled = false;
      }
    }
  }

  cleanupOldestData() {
    for (const plugin in this.pluginSeriesData) {
      for (const key of this.indicatorKeys) {
        const arr = this.pluginSeriesData[plugin][key];
        if (Array.isArray(arr) && arr.length) {
          arr.shift();
        }
      }
    }
    if (this.signalMarkers.length) this.signalMarkers.shift();
    if (this.markLines.length >= 2) this.markLines.splice(0, 2);
    if (this.buyActionsData.length) this.buyActionsData.shift();
    if (this.sellActionsData.length) this.sellActionsData.shift();
  }

  clearState() {
    try {
      localStorage.removeItem(this.storageKey);
      console.log('PluginChart: state cleared');
    } catch (err) {
      console.error('PluginChart: failed to clear state:', err);
    }
  }

initialize() {
  const container = document.getElementById(this.containerId);
  if (!container) {
    console.error("PluginChartCandlesVolume: container not found:", this.containerId);
    return;
  }

  container.style.backgroundColor = '#121212'; // Dark background outside the graph
  container.style.color = '#AAA'; // Text color outside the graph

  this.chartInstance = echarts.init(container);

    // Clear state button
    const clearButton = document.createElement('button');
    clearButton.textContent = 'Clear State';
    clearButton.style.position = 'absolute';
    clearButton.style.top = '10px';
    clearButton.style.left = '10px';
    clearButton.style.zIndex = '1000';
    clearButton.style.backgroundColor = '#121212';
    clearButton.style.color = '#AAA';
    clearButton.style.border = '1px solid #333';
    clearButton.style.padding = '5px 10px';
    clearButton.style.borderRadius = '4px';
    clearButton.style.cursor = 'pointer';
    clearButton.addEventListener('click', () => {
      this.clearState();
      // Reset all chart data and re-render without reloading the page
      this.pluginSeriesData = {};
      this.signalMarkers = [];
      this.markLines = [];
      this.buyActionsData = [];
      this.sellActionsData = [];
      this.candlestickData = { categoryData: [], values: [] };
      this.persistenceEnabled = true; // Re-enable persistence after clearing
      // Truncate arrays to maxVisiblePoints (defensive, in case any are repopulated)
      this.candlestickData.categoryData = this.candlestickData.categoryData.slice(-this.maxVisiblePoints);
      this.candlestickData.values = this.candlestickData.values.slice(-this.maxVisiblePoints);
      this.buyActionsData = this.buyActionsData.slice(-this.maxVisiblePoints);
      this.sellActionsData = this.sellActionsData.slice(-this.maxVisiblePoints);
      this.signalMarkers = this.signalMarkers.slice(-this.maxVisiblePoints);
      this.markLines = this.markLines.slice(-this.maxVisiblePoints);
      // Dispose and re-init chart to avoid stale data and memory leaks
      if (this.chartInstance) {
        this.chartInstance.dispose();
      }
      this.chartInstance = echarts.init(document.getElementById(this.containerId));
      this.refreshChart();
    });
    container.appendChild(clearButton);

    // Mode toggle button
    const modeButton = document.createElement('button');
    modeButton.textContent = this.normalizeWallsGlobally ? 'Mode: Market-Pressure' : 'Mode: Side-Relative';
    modeButton.style.position = 'absolute';
    modeButton.style.top = '10px';
    modeButton.style.left = '120px';
    modeButton.style.zIndex = '1000';
    modeButton.style.backgroundColor = '#121212';
    modeButton.style.color = '#AAA';
    modeButton.style.border = '1px solid #333';
    modeButton.style.padding = '5px 10px';
    modeButton.style.borderRadius = '4px';
    modeButton.style.cursor = 'pointer';
    modeButton.addEventListener('click', () => {
      this.normalizeWallsGlobally = !this.normalizeWallsGlobally;
      modeButton.textContent = this.normalizeWallsGlobally
        ? 'Mode: Market-Pressure'
        : 'Mode: Side-Relative';
      this.refreshChart();
    });
    container.appendChild(modeButton);
    

  // ✅ Load all local state synchronously before rendering or connecting WebSocket
  this.loadState();

  // ✅ Render chart only after state is restored

  // ✅ Now connect to WebSocket
 if (this.klineWebSocketUrl) {
   this.initializeWebSocket();
  }

  this.refreshChart();

}



refreshChart() {
  if (!this.candlestickData.categoryData || this.candlestickData.categoryData.length < 5) {
    console.warn('PluginChart: Waiting for enough candle data to render');
    return;
  }

  const visibleTimes = new Set(this.candlestickData.categoryData);
  const data = this.candlestickData;

  // --> const currentIndex = this.candlestickData.values.length - 1;
  const lastIdx = data.values.length - 1;
  const currentCoord = [ lastIdx, data.values[lastIdx][1] ];


  // find lowest & highest
    let lowIdx = 0, highIdx = 0;
    data.values.forEach((v,i) => {
      if (v[2] < data.values[lowIdx][2])  lowIdx = i;
      if (v[3] > data.values[highIdx][3]) highIdx = i;
    });
    const lowestCoord  = [ lowIdx,  data.values[lowIdx][2] ];
    const highestCoord = [ highIdx, data.values[highIdx][3] ];

    // distance & midpoint
    const dist = (p1,p2) => Math.hypot(p1[0]-p2[0], p1[1]-p2[1]);
    const mid  = (p1,p2) => [(p1[0]+p2[0])/2, (p1[1]+p2[1])/2];

    // triangle sides
    const a = dist(highestCoord, currentCoord);
    const b = dist(lowestCoord,  currentCoord);
    const c = dist(highestCoord, lowestCoord);

    // law of cosines
    const toDeg = r => r * 180 / Math.PI;
    const angleA = toDeg(Math.acos((b*b + c*c - a*a)/(2*b*c)));
    const angleB = toDeg(Math.acos((a*a + c*c - b*b)/(2*a*c)));
    const angleC = 180 - angleA - angleB;

    const angleText = `Angles: A=${angleA.toFixed(2)}°, B=${angleB.toFixed(2)}°, C=${angleC.toFixed(2)}°`;

    // midpoints for labels
    const midAB = mid(currentCoord, lowestCoord);
    const midBC = mid(lowestCoord, highestCoord);
    const midCA = mid(highestCoord, currentCoord);

    // angle markers
    const anglePoints = [
      { coord: midAB, label: { formatter: `A=${angleA.toFixed(2)}°`, show: true, fontSize:15, color:'#90adaaff' }, symbol: 'circle', itemStyle: { color: 'transparent' } },
      { coord: midBC, label: { formatter: `B=${angleB.toFixed(2)}°`, show: true, fontSize:15, color:'#90adaaff' }, symbol: 'circle', itemStyle: { color: 'transparent' } },
      { coord: midCA, label: { formatter: `C=${angleC.toFixed(2)}°`, show: true, fontSize:15, color:'#90adaaff' }, symbol: 'circle', itemStyle: { color: 'transparent' } }
    ];

  const markLineData = [
    [
      { type: 'max', valueDim: 'highest' },
      { type: 'min', valueDim: 'lowest' }
    ],
    [
      { type: 'min', valueDim: 'lowest' },
      { type: 'average', valueDim: 'close' }
    ],
    {
      //name: 'min line on close',
      type: 'min',
      valueDim: 'close'
    },
    {
      //name: 'max line on close',
      type: 'max',
      valueDim: 'close'
    }
  ];

  const markLineSetting = {
    symbol: ['arrow', 'arrow'], // start and end symbols
    symbolRotate: 45, // rotate the arrow by 45 degreess
    symbolSize: [50, 50], // size of the arrow symbols
    lineStyle: {
      color: 'lightgrey',
      width: 1,
      type: 'dashed'
    },
  };

  if (currentCoord) {
    markLineData.push([
      { type: 'max', valueDim: 'highest' },
      { coord: currentCoord }
    ]);
  }

  // Compute the lowest price candle coordinate
  let lowestIndex = 0;
  for (let i = 1; i < this.candlestickData.values.length; i++) {
    if (this.candlestickData.values[i][2] < this.candlestickData.values[lowestIndex][2]) {
      lowestIndex = i;
    }
  }
  /*const lowestCoord = this.candlestickData.values.length
    ? [this.candlestickData.categoryData[lowestIndex], this.candlestickData.values[lowestIndex][2]]
    : null;
*/
  const candlestickSeries = [{
    name: 'Candlestick',
    type: 'candlestick',
    data: this.candlestickData.values,
    itemStyle: {
      color:  this.sanitizeColor('rgba(38,166,154,0.45)'), // 55% transparent
      color0: this.sanitizeColor('rgba(239,83,80,0.45)'),
      borderColor: this.sanitizeColor('#26a69a'), // solid border
      borderColor0: this.sanitizeColor('#ef5350'), // solid border
      borderWidth: 2,
      opacity: 0.65
    },
    z: 20, // always on top
    yAxisIndex: 1, // Force to right axis
    markLine: {
      symbol: ['circle','circle'],
      symbolSize: [6,6],
      lineStyle: { color: this.sanitizeColor('lightgrey'), width: 1, type: 'dashed' },
      label: { show: true, position: 'right', formatter: '{b}', color: this.sanitizeColor('#AAA') },
      precision: 8,
      tooltip: { show: true, formatter: '{b}: {c}' },
      // Use the markLineSetting for all lines
      data: [
        [{ coord: currentCoord }, { coord: lowestCoord }, { ...markLineSetting }],
        [{ coord: lowestCoord }, { coord: highestCoord }, { ...markLineSetting }],
        [{ coord: highestCoord }, { coord: currentCoord }, { ...markLineSetting }],
        ...markLineData,
        ...this.markLines
      ]
    },
    markPoint: {
      data: anglePoints.map(pt => ({
        ...pt,
        label: { ...pt.label, color: this.sanitizeColor(pt.label.color) },
        itemStyle: { ...pt.itemStyle, color: this.sanitizeColor(pt.itemStyle.color) }
      }))
    }
  }];

  const pluginSeries = [];
  for (const plugin in this.pluginSeriesData) {
    for (const key in this.pluginSeriesData[plugin]) {
      if (key === 'sellWalls') {
        // Plot sellWalls as dots at the closest x-axis time to their wall time
        const sellWallsData = this.pluginSeriesData[plugin][key];
        if (Array.isArray(sellWallsData) && sellWallsData.length > 0) {
          const xAxisTimes = this.candlestickData.categoryData;
          const findClosestTime = wallTime => {
            if (!wallTime) return xAxisTimes[xAxisTimes.length - 1];
            let minDiff = Infinity, closest = xAxisTimes[0];
            for (const t of xAxisTimes) {
              let diff = Math.abs(new Date(t) - new Date(wallTime));
              if (diff < minDiff) { minDiff = diff; closest = t; }
            }
            return closest;
          };
          // ASK color interpolation: yellow -> orange -> red
          const askColors = ['#310202ff', '#6c0505ff', '#dd6464ff'];
          const hexToRgba = hex => {
            let c = hex.replace('#','');
            let r = parseInt(c.substring(0,2),16);
            let g = parseInt(c.substring(2,4),16);
            let b = parseInt(c.substring(4,6),16);
            let a = c.length > 6 ? parseInt(c.substring(6,8),16) : 255;
            return [r,g,b,a];
          };
          const rgbaToHex = ([r,g,b,a]) => {
            return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}${a.toString(16).padStart(2,'0')}`;
          };
          const lerp = (a,b,t) => a + (b-a)*t;
          const lerpColor = (c1,c2,t) => c1.map((v,i) => Math.round(lerp(v,c2[i],t)));
          // Precompute 21 colors for 0-20% in 1% steps
          const colorSteps = [];
          for (let i = 0; i <= 20; i++) {
            let t = i / 20;
            let color;
            if (i <= 10) {
              color = lerpColor(hexToRgba(askColors[0]), hexToRgba(askColors[1]), t * 2); // 0-10%
            } else {
              color = lerpColor(hexToRgba(askColors[1]), hexToRgba(askColors[2]), (t - 0.5) * 2); // 10-20%
            }
            colorSteps.push(rgbaToHex(color));
          }
          const getColorByVolumePct = (pct) => {
            let p = Math.max(0, Math.min(20, pct));
            let idx = Math.round(p);
            return colorSteps[idx];
          };
          const darken = (hex, amt) => {
            let c = hex.replace('#','');
            let r = parseInt(c.substring(0,2),16);
            let g = parseInt(c.substring(2,4),16);
            let b = parseInt(c.substring(4,6),16);
            let a = c.length > 6 ? c.substring(6,8) : 'ff';
            r = Math.max(0, Math.min(255, r - amt));
            g = Math.max(0, Math.min(255, g - amt));
            b = Math.max(0, Math.min(255, b - amt));
            return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}${a}`;
          };
          // Only plot balls if price is within candle high/low for the matched time
          const dots = sellWallsData.map(wall => {
            const price = wall[0];
            const wallTime = wall[2];
            const volumePct = wall[3] !== undefined ? wall[3] : 0;
            const plotTime = findClosestTime(wallTime);
            const candleIdx = xAxisTimes.indexOf(plotTime);
            if (candleIdx === -1) return null;
            const candle = this.candlestickData.values[candleIdx];
            if (!candle) return null;
            const candleLow = candle[2];
            const candleHigh = candle[3];
            // Only plot if price is above candle high/low
            if (price < candleLow) return null;
            const color = getColorByVolumePct(volumePct);
            const opacity = Math.min(0.9, Math.max(0.4, volumePct / 100 * 0.7 + 0.4));
            const symbolSize = Math.max(8, Math.min(50, Math.pow(volumePct, 0.9) * 2 + 4));
            const sphereColor = {
              type: 'radial', x: 0.5, y: 0.5, r: 0.5,
              colorStops: [
                { offset: 0, color: this.sanitizeColor(color) },
                { offset: 0.3, color: this.sanitizeColor(darken(color, 32)) },
                { offset: 1, color: this.sanitizeColor(darken(color, 64)) }
              ],
              global: false
            };
            let zValue = typeof wallTime === 'string' ? new Date(wallTime).getTime() : 0;
            return {
              value: [plotTime, price],
              itemStyle: { color: sphereColor, opacity: opacity },
              symbolSize: symbolSize,
              z: zValue
            };
          }).filter(Boolean);
          pluginSeries.push({
            name: `${plugin} Sell Walls`,
            type: 'scatter',
            data: dots,
            symbol: 'circle',
            yAxisIndex: 1,
            z: 10, // below candlestick
            animationEasing: 'elasticIn',
            animationDurationUpdate: 1500,
            animationDelay: (idx) => idx * this.animationSpeed
          });
        } else {
          // console.log(`[DEBUG] Sell Walls for plugin '${plugin}' is not an array or empty.`);
        }
        continue;
      }
      if (key === 'buyWalls') {
        const buyWallsData = this.pluginSeriesData[plugin][key];
        if (Array.isArray(buyWallsData) && buyWallsData.length > 0) {
          const xAxisTimes = this.candlestickData.categoryData;
          const findClosestTime = wallTime => {
            if (!wallTime) return xAxisTimes[xAxisTimes.length - 1];
            let minDiff = Infinity, closest = xAxisTimes[0];
            for (const t of xAxisTimes) {
              let diff = Math.abs(new Date(t) - new Date(wallTime));
              if (diff < minDiff) { minDiff = diff; closest = t; }
            }
            return closest;
          };
          const bidColors = ['#648065ff', '#73b473ff', '#94ed94ff'];
          // Interpolate between bidColors in 2% steps for greater variance
          const hexToRgba = hex => {
            let c = hex.replace('#','');
            let r = parseInt(c.substring(0,2),16);
            let g = parseInt(c.substring(2,4),16);
            let b = parseInt(c.substring(4,6),16);
            let a = c.length > 6 ? parseInt(c.substring(6,8),16) : 255;
            return [r,g,b,a];
          };
          const rgbaToHex = ([r,g,b,a]) => {
            return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}${a.toString(16).padStart(2,'0')}`;
          };
          const lerp = (a,b,t) => a + (b-a)*t;
          const lerpColor = (c1,c2,t) => c1.map((v,i) => Math.round(lerp(v,c2[i],t)));
          // Precompute 21 colors for 0-40% in 2% steps
          // Precompute 21 colors for 0-20% in 1% steps
          const colorSteps = [];
          for (let i = 0; i <= 20; i++) {
            let t = i / 20;
            // Interpolate from bidColors[0] to bidColors[1] for 0-10%, then bidColors[1] to bidColors[2] for 10-20%
            let color;
            if (i <= 10) {
              color = lerpColor(hexToRgba(bidColors[0]), hexToRgba(bidColors[1]), t * 2); // 0-10%
            } else {
              color = lerpColor(hexToRgba(bidColors[1]), hexToRgba(bidColors[2]), (t - 0.5) * 2); // 10-20%
            }
            colorSteps.push(rgbaToHex(color));
          }
          const getColorByVolumePct = (pct) => {
            let p = Math.max(0, Math.min(20, pct));
            let idx = Math.round(p);
            return colorSteps[idx];
          };
          const dots = buyWallsData.map(wall => {
            const price = wall[0];
            const volume = wall[1] || 0;
            const wallTime = wall[2];
            // Use wall percentage for dot sizing
            const volumePct = wall[3] !== undefined ? wall[3] : 0;
            const plotTime = findClosestTime(wallTime);
            // Debug: log if price matches candle close at same time
            const candleIdx = xAxisTimes.indexOf(plotTime);
            if (candleIdx !== -1) {
              const candleClose = this.candlestickData.values[candleIdx][1];
              if (Math.abs(price - candleClose) < 1e-8) {
                console.log(`[DEBUG] BuyWall ball matches candle close: plugin=${plugin}, time=${plotTime}, price=${price}, volumePct=${volumePct}`);
              }
            }
            const color = getColorByVolumePct(volumePct); // Use raw color for gradient
            //console.log(`[COLOR] BuyWall: price=${price}, volumePct=${volumePct}, color=${color}`);
            // Calculate a slightly darker color for offset 0.3 and the darkest for offset 1
            const darken = (hex, amt) => {
              let c = hex.replace('#','');
              let r = parseInt(c.substring(0,2),16);
              let g = parseInt(c.substring(2,4),16);
              let b = parseInt(c.substring(4,6),16);
              let a = c.length > 6 ? c.substring(6,8) : 'ff';
              r = Math.max(0, Math.min(255, r - amt));
              g = Math.max(0, Math.min(255, g - amt));
              b = Math.max(0, Math.min(255, b - amt));
              return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}${a}`;
            };
            const opacity = Math.min(0.9, Math.max(0.4, volumePct / 100 * 0.7 + 0.4));
            const symbolSize = Math.max(8, Math.min(30, Math.pow(volumePct, 0.9) * 2 + 4))
            // Sphere color gradient: offset 0 = bidColor, offset 0.3 = slightly darker, offset 1 = darkest
            const sphereColor = {
              type: 'radial', x: 0.5, y: 0.5, r: 0.5,
              colorStops: [
                { offset: 0, color: this.sanitizeColor(color) },
                { offset: 0.3, color: this.sanitizeColor(darken(color, 32)) },
                { offset: 1, color: this.sanitizeColor(darken(color, 64)) }
              ],
              global: false
            };
            // Assign z based on wallTime (newer = higher)
            let zValue = typeof wallTime === 'string' ? new Date(wallTime).getTime() : 0;
            return {
              value: [plotTime, price],
              itemStyle: { color: sphereColor, opacity: opacity },
              symbolSize: symbolSize,
              z: zValue
            };
          });
          pluginSeries.push({
            name: `${plugin} Buy Walls`,
            type: 'scatter',
            data: dots,
            symbol: 'circle',
            yAxisIndex: 1,
            z: 10, // below candlestick
            animationEasing: 'elasticOut',
            animationDurationUpdate: 1500,
            animationDelay: (idx) => idx * this.animationSpeed
          });
        } else {
          console.log(`[DEBUG] Buy Walls for plugin '${plugin}' is not an array or empty.`);
        }
        continue;
      }
      if (!this.indicatorKeys.includes(key)) continue;
      const lineData = this.pluginSeriesData[plugin][key]
        .map(([rawTimestamp, value]) => {
          const aligned = this.alignTimestamp(rawTimestamp);
          return visibleTimes.has(aligned) ? [aligned, value] : null;
        })
        .filter(Boolean);
      pluginSeries.push({
        name: 'key',
        type: 'line',
        data: lineData,
        symbol: 'circle',
        symbolSize: 0.1,
        smooth: true,
        step: false,
        lineStyle: { width: 0.8, opacity: 1, color: this.sanitizeColor('#AAA') },
        yAxisIndex: 1 // Force to right axis
      });
    }
  }
  const buyActionsSeries = {
    name: 'Buy Actions',
    type: 'scatter',
    data: this.buyActionsData
      .map(([timestamp, price]) => visibleTimes.has(timestamp) ? [timestamp, price] : null)
      .filter(Boolean),
    symbol: 'roundRect',
    label: {
      show: true,
      formatter: function (params) {
        return parseFloat(params.data[1]).toFixed(4);
      },
      fontFamily: 'Arial',
      fontSize: 14,
      color: 'white',
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      borderColor: 'green',
      borderWidth: 1,
      borderRadius: 6,
      padding: [2, 4]
    },
    itemStyle: {},
    yAxisIndex: 1 // Force to right axis
  };

  const sellActionsSeries = {
    name: 'Sell Actions',
    type: 'scatter',
    data: this.sellActionsData
      .map(([timestamp, price]) => visibleTimes.has(timestamp) ? [timestamp, price] : null)
      .filter(Boolean),
    symbol: 'roundRect',
    label: {
      show: true,
      formatter: function (params) {
        return parseFloat(params.data[1]).toFixed(4);
      },
      fontFamily: 'Arial',
      fontSize: 14,
      color: 'white',
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      borderColor: 'red',
      borderWidth: 1,
      borderRadius: 6,
      padding: [2, 4]
    },
    itemStyle: {},
    yAxisIndex: 1 // Force to right axis
  }

  const series = [
    ...candlestickSeries,
    ...pluginSeries,
    buyActionsSeries,
    sellActionsSeries
  ];

  this.chartInstance.setOption({
    title: {
      text: `${this.options.symbol || 'Symbol'} (${new Date().toLocaleDateString()})`,
      right: 10,
      textStyle: { fontSize: 16, fontFamily: 'Arial', color: 'rgba(147, 141, 141, 1)' },
      subtext: angleText,
    },
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
    legend: { data: series.map(s => s.name), selected: {} },
    grid: {
      left: '5%',
      right: '5%',
      bottom: '8%',
      top: '10%',
      backgroundColor: '#1E1E1E',
      borderColor: '#333',
      borderWidth: 1
    },
    xAxis: {
      type: 'category',
      data: this.candlestickData.categoryData,
      scale: true,
      boundaryGap: true,
      axisLine: { onZero: false, lineStyle: { color: '#888' } },
      splitLine: { show: true, lineStyle: { color: '#333' } },
      splitNumber: 10,
      axisLabel: {
        fontFamily: 'Arial',
        fontSize: 16, // Increased font size for clarity
        color: '#FFF',
        fontWeight: 'bold',
        formatter: function (value) {
          // value is already in HH:mm format from alignTimestamp
          return value;
        }
      },
      min: 'dataMin',
      max: 'dataMax'
    },
    yAxis: [
      {
        // left yAxis
        type: 'value',
        scale: true,
        min: this.yAxisMin,
        max: this.yAxisMax,
        splitArea: { show: true, areaStyle: { color: ['#1E1E1E', '#2E2E2E'] } },
        axisLine: { lineStyle: { color: '#888' } },
        axisLabel: {
          show: true,
          fontFamily: 'Arial',
          fontSize: 14,
          color: '#AAA',
          formatter: function(value) {
            // If value is a multiple of 0.01 (major tick)
            if (Math.abs(value * 100 - Math.round(value * 100)) < 1e-6) {
              return value.toFixed(2);
            }
            // Minor tick: show four decimals.
            return value.toFixed(4);
          }
        },
        splitLine: { lineStyle: { color: '#333' } }
      },
      {
        // right yAxis
        type: 'value',
        scale: true,
        min: this.yAxisMin,
        max: this.yAxisMax,
        splitArea: { show: true, areaStyle: { color: ['#1E1E1E', '#2E2E2E'] } },
        position: 'right',
        axisLine: { lineStyle: { color: '#888' } },
        axisLabel: {
          show: true,
          fontFamily: 'Arial',
          fontSize: 14,
          color: '#AAA',
          formatter: function(value) {
            // Major ticks: multiples of 0.01
            if (Math.abs(value * 100 - Math.round(value * 100)) < 1e-6) {
              return value.toFixed(2);
            }
            // Minor ticks: show only if halfway between major ticks (e.g., x.005, x.015, etc.)
            if (Math.abs((value * 100) % 1 - 0.5) < 1e-6) {
              return value.toFixed(3);
            }
            // Otherwise, don't show label
            //return '';
            return value.toFixed(4);
          }
        },
        splitLine: { lineStyle: { color: '#333' } }
      }
    ],
    dataZoom: [
      { type: 'inside', start: 0, end: 100 },
      { show: false, type: 'slider', top: '90%', start: 0, end: 100 }
    ],
    series: series
  });
}


  updateCandlestickData(categoryData, values) {
    this.candlestickData.categoryData = categoryData;
    this.candlestickData.values = values;
    this.refreshChart();
  }

  initializeWebSocket() {
    const socket = new WebSocket(this.klineWebSocketUrl);

    socket.onmessage = (event) => {
      const parseData = (raw) => (typeof raw === 'string' ? JSON.parse(raw) : raw);
      const dataPromise = event.data instanceof Blob ? event.data.text() : Promise.resolve(event.data);

      dataPromise.then((rawData) => {
        const message = parseData(rawData);
        if (Array.isArray(message)) {
          message.forEach(candle => {
            const t = this.alignTimestamp(candle.k.t);
            this.candlestickData.categoryData.push(t);
            this.candlestickData.values.push([
              parseFloat(candle.k.o),
              parseFloat(candle.k.c),
              parseFloat(candle.k.l),
              parseFloat(candle.k.h)
            ]);
            if (this.candlestickData.categoryData.length > this.maxVisiblePoints) {
              this.candlestickData.categoryData.shift();
              this.candlestickData.values.shift();
            }
          });
        } else {
          const candle = message;
          const t = this.alignTimestamp(candle.k.t);
          if (candle.k.x) {
            this.candlestickData.categoryData.push(t);
            this.candlestickData.values.push([
              parseFloat(candle.k.o),
              parseFloat(candle.k.c),
              parseFloat(candle.k.l),
              parseFloat(candle.k.h)
            ]);
            if (this.candlestickData.categoryData.length > this.maxVisiblePoints) {
              this.candlestickData.categoryData.shift();
              this.candlestickData.values.shift();
            }
          } else {
            this.candlestickData.values[this.candlestickData.values.length - 1] = [
              parseFloat(candle.k.o),
              parseFloat(candle.k.c),
              parseFloat(candle.k.l),
              parseFloat(candle.k.h)
            ];
          }
        }
        this.refreshChart();
      });
    };

    socket.onclose = () => {
      console.warn('WebSocket closed. Reconnecting in 5 seconds...');
      setTimeout(() => { this.initializeWebSocket(); }, 5000);
    };

    socket.onerror = (error) => {
      console.error('WebSocket error:', error);
      socket.close();
    };
  }

  resize() {
    if (this.chartInstance) {
      this.chartInstance.resize();
    }
  }

  updateBuyActions(data) {
    this.buyActionsData = data;
    this.refreshChart();
  }

  updateSellActions(data) {
    this.sellActionsData = data;
    this.refreshChart();
  }

  alignTimestamp(timestamp) {
  // Only return time in HH:mm format for x-axis
  const d = new Date(timestamp);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  receiveSignal(signal) {
    const pluginName = signal.plugin;
    if (!pluginName) return;

    if (!this.pluginSeriesData[pluginName]) {
      this.pluginSeriesData[pluginName] = {};
      this.indicatorKeys.forEach(key => {
        this.pluginSeriesData[pluginName][key] = [];
      });
    }

    const timestamp = this.alignTimestamp(signal.timestamp);

    this.indicatorKeys.forEach(key => {
      if (signal.hasOwnProperty(key) && !isNaN(signal[key])) {
        this.pluginSeriesData[pluginName][key].push([signal.timestamp, parseFloat(signal[key])]);
        this.pluginSeriesData[pluginName][key] = this.pluginSeriesData[pluginName][key].slice(-this.maxVisiblePoints);
      }
    });

    if (signal.action === 'PLOTTRADE') {
      // Ensure signal.positions exists and is an object
      if (signal.positions && typeof signal.positions === 'object') {

        Object.entries(signal.positions).forEach(([key, pos]) => {
          // The key for the markLine should be unique to the plugin and position
          const positionKey = `${pluginName}_${key}`;
          // Check if the markLine already exists
          const existingLineIndex = this.markLines.findIndex(line => line.positionKey === positionKey);
          if (existingLineIndex !== -1) {
            // If it exists, update the existing line
            this.markLines[existingLineIndex] = {
              ...this.markLines[existingLineIndex],
              yAxis: pos.entryPrice
            };
          } else {
            // Only add a markLine if the entryPrice is a valid number
            if (pos.entryPrice !== undefined && !isNaN(pos.entryPrice) && pos.entryPrice > 0) {
              this.markLines.push({
                name: `\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0 (${pos.entryPrice})`,
                yAxis: pos.entryPrice,
                positionKey: positionKey, // Track by plugin and position key
                lineStyle: {
                  color: '#1aff00ff',
                  width: 1,
                  type: 'solid'
                },
              });
            }
          }
        });
      }
    }

    if (signal.action === 'BUY') {
      this.buyActionsData.push([timestamp, signal.currentAlphaTrend]);
      //  console.log(`Buy action received at ${timestamp} with signal: ${signal}`);
    } else if (signal.action === 'SELL') {
      this.sellActionsData.push([timestamp, signal.currentAlphaTrend]);
      // console.log(`Sell action received at ${timestamp} with signal: ${signal}`);
    }

    let updated = false;
    // Helper to extract and format wall time
    const extractWallTime = wall => {
      // Prefer lastUpdated, detectedAt, Updated, Detected
      let rawTime = wall.lastUpdated || wall.detectedAt || wall.Updated || wall.Detected;
      if (!rawTime) return undefined;
      // If numeric (timestamp), convert to x-axis format
      if (typeof rawTime === 'number') {
        const d = new Date(rawTime);
        const pad = n => n.toString().padStart(2, '0');
        const year = d.getFullYear();
        const month = pad(d.getMonth() + 1);
        const day = pad(d.getDate());
        const hourStr = pad(d.getHours());
        const minuteStr = pad(d.getMinutes());
        return `${year}-${month}-${day} ${hourStr}:${minuteStr}`;
      }
      // If already in x-axis format, return as is
      if (/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(rawTime)) return rawTime;
      // If in AM/PM format, convert to x-axis format using today's date
      try {
        let d = new Date();
        let [hms, ampm] = rawTime.split(' ');
        let [hour, minute, second] = hms.split(':');
        hour = parseInt(hour, 10);
        if (ampm === 'PM' && hour < 12) hour += 12;
        if (ampm === 'AM' && hour === 12) hour = 0;
        d.setHours(hour, parseInt(minute, 10), parseInt(second, 10), 0);
        // Format as YYYY-MM-DD HH:mm
        const pad = n => n.toString().padStart(2, '0');
        const year = d.getFullYear();
        const month = pad(d.getMonth() + 1);
        const day = pad(d.getDate());
        const hourStr = pad(d.getHours());
        const minuteStr = pad(d.getMinutes());
        return `${year}-${month}-${day} ${hourStr}:${minuteStr}`;
      } catch (e) {
        return undefined;
      }
    };
    // Get latest candle close price for range comparison
    const latestCandle = this.candlestickData.values.length ? this.candlestickData.values[this.candlestickData.values.length - 1] : null;
    const currentPrice = latestCandle ? latestCandle[1] : null;
    // If currentPrice is null, skip wall filtering entirely
    if (currentPrice === null) {
      //console.debug(`[${signal.plugin}] Skipping wall filtering: currentPrice is null.`);
      return;
    }
    if (signal.sellWalls && Array.isArray(signal.sellWalls)) {
      let currentArr = this.pluginSeriesData[pluginName].sellWalls || [];
      signal.sellWalls.forEach(wall => {
        const wallTime = extractWallTime(wall);
        if (!wallTime || typeof wall.price !== 'number' || typeof wall.volume !== 'number') {
          return;
        }
        const pct = Number.isFinite(wall.percentage) ? parseFloat(wall.percentage) : (Number.isFinite(wall[3]) ? parseFloat(wall[3]) : 0);
        if (currentPrice !== null) {
          const priceDiffPct = Math.abs((wall.price - currentPrice) / currentPrice) * 100;
          if (priceDiffPct > this.wallPctRange) {
            return;
          }
        }
        // Find if there's an existing entry with same time and pct within wallReplacePctRange
        const idx = currentArr.findIndex(([_, __, t, p]) => t === wallTime && Math.abs((parseFloat(p) || 0) - pct) < this.wallReplacePctRange);
        if (idx !== -1) {
          currentArr[idx] = [wall.price, wall.volume, wallTime, pct];
        } else {
          currentArr.push([wall.price, wall.volume, wallTime, pct]);
        }
      });
      // Deduplicate: keep only the latest wall per unique time and pct (within wallReplacePctRange)
      const dedupedArr = [];
      currentArr.forEach(wall => {
        const [price, volume, wallTime, pct] = wall;
        const idx = dedupedArr.findIndex(([_, __, t, p]) => t === wallTime && Math.abs((parseFloat(p) || 0) - pct) < this.wallReplacePctRange);
        if (idx === -1) {
          dedupedArr.push(wall);
        } else {
          // If duplicate, keep the latest (higher price/volume/pct)
          dedupedArr[idx] = wall;
        }
      });
      dedupedArr.sort((a, b) => new Date(a[2]) - new Date(b[2]));
      this.pluginSeriesData[pluginName].sellWalls = dedupedArr.slice(-this.maxWalls);
      updated = true;
    }
    if (signal.buyWalls && Array.isArray(signal.buyWalls)) {
      let currentArr = this.pluginSeriesData[pluginName].buyWalls || [];
      // Log all incoming buy wall percentages before filtering
      signal.buyWalls.forEach(wall => {
        const pctRaw = Number.isFinite(wall.percentage) ? parseFloat(wall.percentage) : (Number.isFinite(wall[3]) ? parseFloat(wall[3]) : 0);
        //console.log(`[RAW BUY WALL] price=${wall.price}, volume=${wall.volume}, pct=${pctRaw}`);
      });
      signal.buyWalls.forEach(wall => {
        const wallTime = extractWallTime(wall);
        if (!wallTime || typeof wall.price !== 'number' || typeof wall.volume !== 'number') {
          return;
        }
        const pct = Number.isFinite(wall.percentage) ? parseFloat(wall.percentage) : (Number.isFinite(wall[3]) ? parseFloat(wall[3]) : 0);
        if (currentPrice !== null) {
          const priceDiffPct = Math.abs((wall.price - currentPrice) / currentPrice) * 100;
          if (priceDiffPct > this.wallPctRange) {
            return;
          }
        }
        // Find if there's an existing entry with same time and pct within wallReplacePctRange
        const idx = currentArr.findIndex(([_, __, t, p]) => t === wallTime && Math.abs((parseFloat(p) || 0) - pct) < this.wallReplacePctRange);
        if (idx !== -1) {
          if (pct > (parseFloat(currentArr[idx][3]) || 0)) {
            currentArr[idx] = [wall.price, wall.volume, wallTime, pct];
          }
        } else {
          currentArr.push([wall.price, wall.volume, wallTime, pct]);
        }
      });
      // Deduplicate: keep only the latest wall per unique time and pct (within wallReplacePctRange)
      const dedupedArr = [];
      currentArr.forEach(wall => {
        const [price, volume, wallTime, pct] = wall;
        const idx = dedupedArr.findIndex(([_, __, t, p]) => t === wallTime && Math.abs((parseFloat(p) || 0) - pct) < this.wallReplacePctRange);
        if (idx === -1) {
          dedupedArr.push(wall);
        } else {
          // If duplicate, keep the latest (higher price/volume/pct)
          dedupedArr[idx] = wall;
        }
      });
      dedupedArr.sort((a, b) => new Date(a[2]) - new Date(b[2]));
      this.pluginSeriesData[pluginName].buyWalls = dedupedArr.slice(-this.maxWalls);
    }
    //if (updated) {
      //console.log(`[${pluginName}] Received signal:`, signal);
      //console.log(`[${pluginName}] Series data:`, this.pluginSeriesData[pluginName]);
    //}

    this.refreshChart();
    this.saveState();
  }
}
