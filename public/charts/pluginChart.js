class PluginChart {
  constructor(options = {}) {
    this.options            = options;
    this.timezone           = options.timezone || 'Europe/London';
    this.pluginSeriesData   = {};
    this.colorPalette       = ["#FF0000", "#00FF00", "#0000FF", "#800080", "#FFA500", "#FFFF00", "#008080", "#000000"];
    this.indicatorKeys      = options.indicatorKeys || [];
    this.yAxisMax           = options.yAxisMax || 100;
    this.yAxisMin           = options.yAxisMin || -100;
    this.maxVisiblePoints   = options.maxVisiblePoints || 180;
    this.containerId        = options.containerId || 'pluginChart';
    this.chartInstance      = null;
    this.pluginName         = options.pluginName || 'Plugin';
    this.symbol             = options.symbol || '';
    this.signalMarkers      = [];
    this.markLines          = options.markLines || [];
    this.storageKey         = `${this.containerId}_${this.symbol}`;
    this.persistenceEnabled = true;
  }

  loadState() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;
      const { pluginSeriesData, signalMarkers, markLines } = JSON.parse(raw);
      if (pluginSeriesData) this.pluginSeriesData = pluginSeriesData;
      if (signalMarkers)    this.signalMarkers    = signalMarkers;
      if (Array.isArray(markLines) && markLines.length > 0) {
        this.markLines = markLines;
      }
    } catch (err) {
      console.warn('PluginChart: failed to load state:', err);
    }
  }

  saveState() {
    if (!this.persistenceEnabled) return;
    const payload = JSON.stringify({
      pluginSeriesData: this.pluginSeriesData,
      signalMarkers:    this.signalMarkers,
      markLines:        this.markLines
    });

    try {
      localStorage.setItem(this.storageKey, payload);
    } catch (err) {
      const isQuotaExceeded = (
        err instanceof DOMException &&
        (err.name === 'QuotaExceededError' ||
         err.name === 'NS_ERROR_DOM_QUOTA_REACHED')
      );
      if (isQuotaExceeded) {
        this.cleanupOldestData();
        try {
            const currentTime = Date.now();
            const threeHoursAgo = currentTime - (3 * 60 * 60 * 1000);
            // Filter out any data points in pluginSeriesData older than 3 hours ago
            for (const plugin in this.pluginSeriesData) {
            for (const key of this.indicatorKeys) {
              if (Array.isArray(this.pluginSeriesData[plugin][key])) {
              this.pluginSeriesData[plugin][key] = this.pluginSeriesData[plugin][key].filter(item => item[0] >= threeHoursAgo);
              }
            }
            }
            // Filter out any signal markers older than 3 hours ago
            this.signalMarkers = this.signalMarkers.filter(marker => marker.timestamp >= threeHoursAgo);
            localStorage.setItem(this.storageKey, JSON.stringify({
            pluginSeriesData: this.pluginSeriesData,
            signalMarkers:    this.signalMarkers,
            markLines:        this.markLines
            }));
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
        if (Array.isArray(arr) && arr.length > this.maxVisiblePoints) {
          // Remove all older points beyond maxVisiblePoints in one go.
          const excess = arr.length - this.maxVisiblePoints;
          arr.splice(0, excess);
        }
      }
    }
    // Optional: If you intend to limit markers similarly, adjust below.
    if (this.signalMarkers.length > this.maxVisiblePoints) {
      const excessMarkers = this.signalMarkers.length - this.maxVisiblePoints;
      this.signalMarkers.splice(0, excessMarkers);
    }
    // The behavior for markLines remains unchanged if required.
    if (this.markLines.length >= 2) {
      this.markLines.splice(0, 2);
    }
  }

  bindEvents() {
    window.addEventListener('resize', () => this.resize());
  }

  clearState() {
    try {
      localStorage.removeItem(this.storageKey);
      this.pluginSeriesData = {};
      this.signalMarkers = [];
      this.markLines = [];
      this.refreshChart();
    } catch (err) {
      console.error('PluginChart: failed to clear state:', err);
    }
  }

  initialize() {
    console.log('Initializing PluginChart with containerId:', this.containerId);
    const container = document.getElementById(this.containerId);
    if (!container) {
    container.style.backgroundColor = '#1E1E1E';
    container.style.color           = '#E0E0E0';
    container.style.position        = 'relative';
    }

    container.style.backgroundColor = '#1E1E1E';
    container.style.color           = '#E0E0E0';

    this.chartInstance = echarts.init(container);
    this.bindEvents();

    const clearButton = document.createElement('button');
    clearButton.textContent = 'CLEAR';
    clearButton.style.position    = 'absolute';
    clearButton.style.top      = '10px';
    clearButton.style.right       = '40px';
    clearButton.style.zIndex      = '1000';
    clearButton.style.backgroundColor = '#000000';
    clearButton.style.color           = '#E0E0E0';
    clearButton.style.border          = '1px solid rgb(22, 21, 21)';
    clearButton.style.padding         = '2px 4px';
    clearButton.style.fontSize        = '14px';
    clearButton.style.cursor          = 'pointer';
    clearButton.addEventListener('click', () => this.clearState());
    container.appendChild(clearButton);

    this.loadState();
    this.refreshChart();
  }

  refreshChart() {
    const pluginSeries = [];

    // Build indicator lines
    for (const plugin in this.pluginSeriesData) {
      if (!this.pluginSeriesData.hasOwnProperty(plugin)) continue;
      for (const key in this.pluginSeriesData[plugin]) {
        if (!this.pluginSeriesData[plugin].hasOwnProperty(key)) continue;
        if (!this.indicatorKeys.includes(key)) continue;
        pluginSeries.push({
          name: key,
          type: 'line',
          data: this.pluginSeriesData[plugin][key].map(item => [ item[0], item[1] ]),
          symbol: 'circle',
          symbolSize: 0.2,
          smooth: true,
          lineStyle: { width: 1.5, opacity: 1 }
        });
      }
    }

    // Binance‐style colors
    const binanceColors = ['#F0B90B', '#1E90FF', '#32CD32', '#FF4500', '#9400D3'];
    pluginSeries.forEach((series, idx) => {
      if (idx < binanceColors.length) {
        series.itemStyle = { color: binanceColors[idx] };
      }
    });

    // Vertical BUY/SELL markers
    const markersSeries = {
      type: 'line',
      data: [],
      markLine: {
        silent: true,
        symbol: ['none','none'],
        lineStyle: { type: 'solid', width: 1.5, opacity: 0.8 },
        animation: false,
        label: {
          show: true,
          formatter: params => {
            const m = this.signalMarkers.find(m => m.timestamp === params.value);
            return m ? m.action : '';
          },
          color: '#E0E0E0'
        },
        data: this.signalMarkers.map(marker => {
          const c = marker.action.toUpperCase() === 'BUY'  ? '#32CD32'
                  : marker.action.toUpperCase() === 'SELL' ? '#FF4500'
                  : '#808080';
          return {
            xAxis: marker.timestamp,
            lineStyle: { color: c, width: 5, opacity: 0.2 }
          };
        })
      }
    };
    pluginSeries.push(markersSeries);

    // Horizontal dynamic lines
    if (!Array.isArray(this.markLines) || this.markLines.length < 2) {
      console.warn('PluginChart: No valid markLines provided, skipping dynamic lines.');
    } else {
      const dynamicMarkLines = [];
      for (let i = 0; i < this.markLines.length; i += 2) {
        const value = Number(this.markLines[i]);
        const color = this.markLines[i+1];
        if (!isNaN(value) && typeof color === 'string') {
          dynamicMarkLines.push({ yAxis: value, lineStyle: { color, type: 'dashed' } });
        }
      }

      pluginSeries.push({
        type: 'line',
        data: [],
        markLine: { silent: true, data: dynamicMarkLines }
      });
    }

    if (!this.chartInstance) return;

    const yAxisConfig = {
      scale: true,
      min: this.yAxisMin,
      max: this.yAxisMax,
      splitArea: { show: true },
      axisLine: { lineStyle: { color: '#E0E0E0' } },
      axisLabel: { color: '#E0E0E0' }
    };

    const sharedYAxis = [
      { ...yAxisConfig, position: 'left' },
      { ...yAxisConfig, position: 'right', alignTicks: true } // Ensure alignment
    ];

    this.chartInstance.setOption({
      title: {
        text: `${this.pluginName} [${this.symbol.toUpperCase()}]`,
        left: 'center',
        textStyle: { 
          color: '#FFF',
          fontFamily: 'Arial',
          fontSize: 16, // Increased font size for clarity
          fontWeight: 'bold'
         }
      },
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
      grid: { left: '5%', right: '5%', bottom: '10%', top: '10%' },
      xAxis: {
        type: 'time',
        scale: true,
        axisLine: { onZero: false, lineStyle: { color: '#E0E0E0' } },
        axisLabel: {
          color: '#FFF',
          fontFamily: 'Arial',
          fontSize: 16, // Increased font size for clarity
          fontWeight: 'bold',
          formatter: ts => {
            // Show only time in HH:mm format
            const d = new Date(ts);
            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
          }
        },
        splitLine: { show: false },
        splitNumber: 10,
        min: 'dataMin',
        max: 'dataMax'
      },
      yAxis: sharedYAxis, // Use shared Y-axis configuration
      dataZoom: [
        { type: 'inside', start: 0, end: 100 },
        {
          show: false,
          type: 'slider',
          top: '90%',
          start: 0,
          end: 100,
          backgroundColor: '#1E1E1E',
          fillerColor: '#F0B90B'
        }
      ],
      series: pluginSeries
    });

    this.saveState();
  }

  resize() {
    if (this.chartInstance) {
      this.chartInstance.resize();
    }
  }

  receiveSignal(signalData) {
    if (signalData.side && ['BUY', 'SELL'].includes(signalData.side.toUpperCase())) {
      console.info('PluginChart: Received signal data:', signalData);
    }

    if (!this.pluginSeriesData[signalData.plugin]) {
      this.pluginSeriesData[signalData.plugin] = {};
      this.indicatorKeys.forEach(k => {
        this.pluginSeriesData[signalData.plugin][k] = [];
      });
    }

    // Append indicator values (with UTC ms timestamp)
    this.indicatorKeys.forEach(k => {
      if (signalData.hasOwnProperty(k) && !isNaN(signalData[k])) {
        const ts = signalData.timestamp || Date.now();
        this.pluginSeriesData[signalData.plugin][k].push([ts, parseFloat(signalData[k])]);
        this.pluginSeriesData[signalData.plugin][k] =
          this.pluginSeriesData[signalData.plugin][k].slice(-this.maxVisiblePoints);
      }
    });

    // Append BUY/SELL markers
    if (signalData.side && ['BUY','SELL'].includes(signalData.side.toUpperCase())) {
      const ts = signalData.timestamp || Date.now();
      this.signalMarkers.push({ timestamp: ts, action: signalData.side });
    }

    //console.log('PluginChart: Updated pluginSeriesData:', this.pluginSeriesData);
    //console.log('PluginChart: Updated signalMarkers:', this.signalMarkers);

    this.refreshChart();
  }
}
