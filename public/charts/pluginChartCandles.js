class PluginChartCandles {
  constructor(options = {}) {
    this.options = options;
    this.pluginSeriesData = {};
    this.colorPalette = ["#FF0000", "#00FF00", "#0000FF", "#800080", "#FFA500", "#FFFF00", "#008080", "#000000"];
    this.indicatorKeys = ["prevAlphaTrend", "currentAlphaTrend", "ma200"];
    this.yAxisMin = options.yAxisMin || 'dataMin';
    this.yAxisMax = options.yAxisMax || 'dataMax';
    this.maxVisiblePoints = options.maxVisiblePoints || 360;
    this.containerId = options.containerId || 'pluginChart';
    this.chartInstance = null;
    this.signalMarkers = [];
    this.markLines = options.markLines || [];
    this.candlestickData = { categoryData: [], values: [] };
    this.klineWebSocketUrl = options.klineWebSocketUrl || "ws://192.168.0.91:8080?symbol=ZROUSDT&duration=1m&limit=180";
    this.storageKey = `PluginChartState_${this.containerId}_${options.symbol || 'defaultSymbol'}`;
    this.persistenceEnabled = true;
    this.buyActionsData = [];
    this.sellActionsData = [];
  }

  loadState() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;

      const { pluginSeriesData, signalMarkers, markLines, buyActionsData, sellActionsData } = JSON.parse(raw);

      if (pluginSeriesData) this.pluginSeriesData = pluginSeriesData;
      if (signalMarkers) this.signalMarkers = signalMarkers;
      if (markLines) this.markLines = markLines;
      if (buyActionsData) this.buyActionsData = buyActionsData;
      if (sellActionsData) this.sellActionsData = sellActionsData;

      console.log('PluginChart: Restored state from localStorage.');
    } catch (err) {
      console.warn('PluginChart: failed to load state:', err);
    }
  }

  saveState() {
    if (!this.persistenceEnabled) return;

    const payload = JSON.stringify({
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
    console.error("PluginChartCandles: container not found:", this.containerId);
    return;
  }

  container.style.backgroundColor = '#121212'; // Dark background outside the graph
  container.style.color = '#AAA'; // Text color outside the graph

  this.chartInstance = echarts.init(container);

  // Adjust the Clear State button styling and placement
  const clearButton = document.createElement('button');
  clearButton.textContent = 'Clear State';
  clearButton.style.position = 'absolute';
  clearButton.style.top = '10px';
  clearButton.style.left = '10px'; // Move to top left
  clearButton.style.zIndex = '1000';
  clearButton.style.backgroundColor = '#121212'; // Dark grey background
  clearButton.style.color = '#AAA'; // Light grey text
  clearButton.style.border = '1px solid #333'; // Clean dark grey border
  clearButton.style.padding = '5px 10px';
  clearButton.style.borderRadius = '4px';
  clearButton.style.cursor = 'pointer';
  clearButton.addEventListener('click', () => {
    this.clearState();
    location.reload(); // Reload to reinit chart cleanly
  });
  container.appendChild(clearButton);
    

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

//THERE SOME DUPLICATE CODE HERE, WILL REFACTOR LATER!!!!!  
// Patience please, I am not a robot, I am a human being, I need to take breaks and rest too!


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
      { coord: midAB, label: { formatter: `A=${angleA.toFixed(2)}°`, show: true, fontSize:40, color:'white' }, symbol: 'none' },
      { coord: midBC, label: { formatter: `B=${angleB.toFixed(2)}°`, show: true, fontSize:40, color:'white' }, symbol: 'none' },
      { coord: midCA, label: { formatter: `C=${angleC.toFixed(2)}°`, show: true, fontSize:40, color:'white' }, symbol: 'none' }
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
    symbolRotate: 45 // rotate the arrow by 45 degreess
  };

  if (currentCoord) {
    // Non-triangle auxiliary line: connect the computed max(highest) data point
    // to the currentCoord. NOTE: the left endpoint is specified via a valueDim
    // ({ type: 'max', valueDim: 'highest' }) which ECharts resolves at render
    // time to the data point with the highest 'highest' value. This is an
    // auxiliary reference line (not the explicit triangle vertex 'highestCoord')
    // and therefore is NOT one of the three vertex-to-vertex triangle sides.
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
      color:  '#26a69a',
      color0: '#ef5350',
      borderColor: '#26a69a',
      borderColor0: '#ef5350'
    },
    markLine: {
      symbol: ['circle','circle'],
      symbolSize: [6,6],
      lineStyle: { color: 'lightgrey', width: 1, type: 'dashed' },
      label: { show: true, position: 'end', formatter: '{b}' },
      precision: 2,
      tooltip: { show: true, formatter: '{b}: {c}' },
      // Use the markLineSetting for all lines
    
      data: [
        // Triangle side: currentCoord -> lowestCoord (vertex-to-vertex)
        [{ coord: currentCoord }, { coord: lowestCoord }],
        // Triangle side: lowestCoord -> highestCoord (vertex-to-vertex)
        [{ coord: lowestCoord }, { coord: highestCoord }],
        // Triangle side: highestCoord -> currentCoord (vertex-to-vertex)
        [{ coord: highestCoord }, { coord: currentCoord }],
        // Non-triangle auxiliary line: connects currentCoord to the midpoint
        // between lowest and highest (midBC). This draws a line to an interior
        // midpoint, not a triangle vertex, so it is NOT a triangle side.
        [{ coord: currentCoord }, { coord: midBC }], // <-- auxiliary line to midpoint
        ...markLineData
      ]
    },
    markPoint: {
      data: anglePoints
    }
  }];

  const pluginSeries = [];

  for (const plugin in this.pluginSeriesData) {
    for (const key in this.pluginSeriesData[plugin]) {
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
        lineStyle: { width: 0.8, opacity: 1 }
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
      fontSize: 10,
      color: 'white',
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      borderColor: 'green',
      borderWidth: 1,
      borderRadius: 6,
      padding: [2, 4]
    },
    itemStyle: {}  
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
      fontSize: 10,
      color: 'white',
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      borderColor: 'red',
      borderWidth: 1,
      borderRadius: 6,
      padding: [2, 4]
    },
    itemStyle: {}
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
      textStyle: { fontSize: 16, fontFamily: 'Arial', color: '#333' },
      subtext: angleText,
    },
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
    legend: { data: series.map(s => s.name), selected: {} },
    grid: {
      left: '5%',
      right: '5%',
      bottom: '8%',
      top: '10%',
      backgroundColor: '#1E1E1E', // Dark background similar to Binance
      borderColor: '#333', // Subtle border color
      borderWidth: 1
    },
    xAxis: {
      type: 'category',
      data: this.candlestickData.categoryData,
      scale: true,
      boundaryGap: false,
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
        //left yAxis
        type: 'value',
        scale: true,
        min: this.yAxisMin,
        max: this.yAxisMax,
        splitArea: { show: true, areaStyle: { color: ['#1E1E1E', '#2E2E2E'] } },
        axisLine: { lineStyle: { color: '#888' } },
        axisLabel: { fontFamily: 'Arial', fontSize: 10, color: '#AAA' },
        splitLine: { lineStyle: { color: '#333' } }
      },
      {
        //right yAxis
        type: 'value',
        scale: true,
        min: this.yAxisMin,
        max: this.yAxisMax,
        splitArea: { show: true, areaStyle: { color: ['#1E1E1E', '#2E2E2E'] } },
        position: 'right',
        axisLine: { lineStyle: { color: '#888' } },
        axisLabel: { fontFamily: 'Arial', fontSize: 10, color: '#AAA' },
        splitLine: { lineStyle: { color: '#333' } }
      }
    ],
    dataZoom: [
      { type: 'inside', start: 0, end: 100 },
      { show: false, type: 'slider', top: '90%', start: 0, end: 100 }
    ],
    series: series.map(s => ({
      ...s,
      yAxisIndex: s.name === 'Candlestick' || s.name === 'Buy Actions' || s.name === 'Sell Actions' ? 1 : 0
    }))
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

    if (signal.action === 'BUY') {
      this.buyActionsData.push([timestamp, signal.currentAlphaTrend]);
    } else if (signal.action === 'SELL') {
      this.sellActionsData.push([timestamp, signal.currentAlphaTrend]);
    }

    this.refreshChart();
    this.saveState();
  }
}
//export default PluginChartCandles;
// Usage example: 
// const chart = new PluginChartCandles({ containerId: 'myChartContainer', klineWebSocketUrl: 'ws://example.com/kline' });
// chart.initialize();
// chart.updateCandlestickData(['2023-10-01 00:00', '2023-10-01 00:01'], [[100, 105, 95, 110], [105, 107, 102, 108]]);
// chart.receiveSignal({ plugin: 'myPlugin', timestamp: Date.now(), prevAlphaTrend: 0.5, currentAlphaTrend: 0.6, ma200: 100, action: 'BUY' });
// chart.updateBuyActions([[Date.now(), 0.6]]);
// chart.updateSellActions([[Date.now(), 0.7]]);
// Note: Ensure you have ECharts library loaded in your HTML for this to work.
// <script src="https://cdn.jsdelivr.net/npm/echarts/dist/echarts.min.js"></script>
// PluginChartCandles.js
// const WebSocket = require('ws');
// const echarts = require('echarts'); // Ensure ECharts is available globally or import it correctly
// const PluginChartCandles = require('./PluginChartCandles'); // Adjust the import path as needed


