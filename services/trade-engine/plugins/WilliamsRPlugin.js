const WebSocket = require('ws');
const createPluginLogger = require('./pluginsLogger');
const { logInfo, logWarn, logError } = createPluginLogger('WSilliamsRPlugin') || require('../logger');
const WebSocketClient = require('../../../includes/WebSocketClient');
const { EMA } = require('technicalindicators');
const logger = require('../logger');
const { json } = require('express');

class WilliamsRPlugin {
	constructor(options = {}) {
		this.name = 'WilliamsRPlugin';
		this.ws = null;
		this.klineWS = options.klineWS || null;
		this.symbol = options.symbol || null;
		this.duration = options.duration || '1m';
		this.limit = options.limit || 120;
		this.currentAggregatedCandle = null;

		this.broadcastClient = new WebSocketClient(options.broadcastClientWS || 'ws://localhost:8083');
	
		this.broadcastClient.on('open', () => { logInfo('Connected to broadcast server on port 8083.'); });
		this.broadcastClient.on('error', (error) => logError('WebSocket error:', error));
		this.broadcastClient.on('close', () => logWarn('WebSocket closed.'));

		this.williamsRData = {
			highs: [],
			lows: [],
			closes: [],
			outputs: [],
			trendReq: options.trendReq || 'Ranging',
			length: options.length || 21,
			emaLength: options.emaLength || 7,
			buyWilly: options.buyWilly || -80,
			sellWilly: options.sellWilly || -20,
			sellEmaThreshold: options.sellEmaThreshold || -10,
			buyEmaThreshold: options.buyEmaThreshold || -90
		};

		this.historicalDataLoaded = false;
		this.lastSignalAction = null;
		this.lastSignalTimestamp = null;
		this.lastSignalPrice = null;
		this.clientOrderId = null;

		
		this.evaluationHistory = [];
	}


	initializeWebSocket(klineWS) {
		if (klineWS) this.klineWS = klineWS;
		if (!this.klineWS) {
			logError(`[${this.name} - ${this.symbol}] klineWS not provided. Cannot initialize WebSocket.`);
			return;
		}
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			return;
		}
		logInfo(`[${this.name} - ${this.symbol}] Connecting to ${this.klineWS}...`);
		this.ws = new WebSocket(this.klineWS);
		logInfo('[Debug WilliamsRPlugin] WebSocket created.', this.ws);

		this.ws.on('message', (Kline) => {
		
			const klineStr = (typeof Kline === 'string') ? Kline : Kline.toString('utf8');
		// console.log('[Debug WilliamsRPlugin] - This is the klineStr', klineStr);
			if (klineStr.includes('kline')) {
			const klineData = JSON.parse(klineStr);
			if (klineData.k.x === true) {
		//	   console.log('[Debug WilliamsRPlugin] - This is the klineData', klineData.k);
				this.processWebSocketMessage(klineData.k);
			}
			return;
			}
		});
		this.ws.on('close', () => {
			logWarn(`[${this.name} - ${this.symbol}] Connection closed. Reconnecting in 5 seconds...`);
			setTimeout(() => this.initializeWebSocket(), 5000);
		});
		this.ws.on('error', (error) => logError(`[${this.name} - ${this.symbol}] WebSocket error: ${error.message}`));
		}


		
	broadcastSignal(signalData) {

		const message = {
		  type: 'signal',
		  data: signalData,
		  timestamp: Date.now()
		};
		this.broadcastClient.send(message);
	  }
	

	  processWebSocketMessage(klineData) {
		try {
		  // Processing only 1m candles.
		  this.processNewPriceData(klineData, false);
		//  logInfo(`[WilliamsRPlugin Debug] Processing 1m Kline Data -> Timestamp: ${klineData.t}, Close: ${klineData.c}`);
		} catch (error) {
		  logError(`[${this.name} - ${this.symbol}] Error processing message: ${error.message}`);
		}
	  }

	
	// Static helper: Calculate Williams %R outputs over a series of candles.
	static calculateWilliamsOutputs(highs, lows, closes, period) {
		let outputs = [];
		for (let i = period - 1; i < highs.length; i++) {
			const windowHigh = Math.max(...highs.slice(i - period + 1, i + 1));
			const windowLow = Math.min(...lows.slice(i - period + 1, i + 1));
			const output = 100 * (closes[i] - windowHigh) / (windowHigh - windowLow);
			outputs.push(output);
		}
		return outputs;
	}

	async processNewPriceData({ c: price, h: high, l: low, t: timestamp }, isHistorical = false) {
		const source = isHistorical ? "Historical" : "Live";
		//logInfo(`[${this.name} - ${this.symbol}] Processing ${source} Data -> Timestamp: ${timestamp}, Close: ${price}, High: ${high}, Low: ${low}`);
		this.williamsRData.highs.push(high);
		this.williamsRData.lows.push(low);
		this.williamsRData.closes.push(price);
		if (this.williamsRData.highs.length > this.williamsRData.length) {
			this.williamsRData.highs.shift();
			this.williamsRData.lows.shift();
			this.williamsRData.closes.shift();
		}
		if (this.williamsRData.highs.length >= this.williamsRData.length) {
			const decision = await this.makeDecision({ price, high, low, t: timestamp });
			decision.price = price;
			decision.source = source;
			decision.timestamp = timestamp;
			
			if (decision.action === 'BUY' || decision.action === 'SELL') {
				logInfo(`[${this.name} - ${this.symbol}] Decision made: ${decision.action} at price ${price} | Williams %R: ${decision.williamsR.toFixed(4)} | EMA: ${decision.ema.toFixed(4)}`);
				this.broadcastSignal(decision);
			} else {
				//logInfo(`[${this.name} - ${this.symbol}] Decision is HOLD. Broadcasting plugin metrics signal.`);
				this.broadcastSignal(decision);
			}
			return decision;
		} else {
		//	logInfo(`[${this.name} - ${this.symbol}] Not enough data for final calculation yet. Current count: ${this.williamsRData.highs.length}`);
			return {
				plugin: 'WilliamsRPlugin',
				symbol: this.symbol,
				laction: this.lastSignalAction,
				tslactiondate: this.lastSignalTimestamp,
				laprice: this.lastSignalPrice,
				action: 'HOLD',
				price,
				williamsR: null,
				ema: null,
				reason: 'Insufficient data',
				timestamp
			};
		}
	}

async makeDecision({ price, high, low, t }) {
	try {
		if (this.williamsRData.highs.length < this.williamsRData.length) {
			throw new Error("Insufficient data");
		}

		const outputs = WilliamsRPlugin.calculateWilliamsOutputs(
			this.williamsRData.highs,
			this.williamsRData.lows,
			this.williamsRData.closes,
			this.williamsRData.length
		);
		const currentOutput = outputs[outputs.length - 1];
		this.williamsRData.outputs.push(currentOutput);

		// Prevent memory issues
		if (this.williamsRData.outputs.length > this.williamsRData.emaLength * 2) {
			this.williamsRData.outputs = this.williamsRData.outputs.slice(-this.williamsRData.emaLength * 2);
		}

		const emaValues = EMA.calculate({ period: this.williamsRData.emaLength, values: this.williamsRData.outputs });
		const currentEMA = emaValues[emaValues.length - 1];

		const roundedWilly = parseFloat(currentOutput);
		const roundedEMA = parseFloat(currentEMA);

		let action = 'HOLD';
		let reason = 'No strong signal';

		// Reversal detection enhancement
		const wasWillyRising = this.prevWilly !== null && roundedWilly > this.prevWilly;
		const crossoverJustHappened = this.prevWilly !== null && this.prevWilly < this.prevEMA && roundedWilly >= roundedEMA;
		const willySlope = this.prevWilly !== null ? roundedWilly - this.prevWilly : 0;
		const emaSlope = this.prevEMA !== null ? roundedEMA - this.prevEMA : 0;

		if (
			roundedWilly < -80 &&
			roundedEMA < this.williamsRData.buyEmaThreshold &&
			crossoverJustHappened &&
			wasWillyRising &&
			willySlope > 0 &&
			emaSlope >= 0
		) {
			const timeStamp = new Date(t).toISOString();
			const diff = roundedWilly - roundedEMA;

			this.evaluationHistory.push({
				Time: timeStamp,
				roundedWilly: roundedWilly.toFixed(4),
				currentEMA: roundedEMA.toFixed(4),
				"Willy Slope": willySlope.toFixed(4),
				"EMA Slope": emaSlope.toFixed(4),
				"Was Willy Rising?": wasWillyRising,
				"Crossover Just Happened": crossoverJustHappened,
				"Diff (Willy - EMA)": diff.toFixed(4),
				"✅ All Conditions Met": true
			});

			if (this.evaluationHistory.length > 50) {
				this.evaluationHistory = this.evaluationHistory.slice(-50);
			}

			console.clear();
			console.log('\n' + '*'.repeat(40));
			console.table(this.evaluationHistory);
			console.log('*'.repeat(40));

			action = 'BUY';
			reason = `Reversal signal: Williams %R (${roundedWilly.toFixed(4)}) rising through EMA (${roundedEMA.toFixed(4)}) with slope confirmation.`;

		}
		else 
		if (
		roundedWilly > -20 &&
		roundedEMA > this.williamsRData.sellEmaThreshold &&
		this.prevWilly !== null &&
		this.prevEMA !== null
		) {
		const timeStamp = new Date(t).toISOString();
		const crossoverJustHappened = this.prevWilly > this.prevEMA && roundedWilly <= roundedEMA;
		const wasWillyFalling = roundedWilly < this.prevWilly;
		const willySlope = roundedWilly - this.prevWilly;
		const emaSlope = roundedEMA - this.prevEMA;

		const allConditionsMet = crossoverJustHappened && wasWillyFalling && willySlope < 0 && emaSlope <= 0;

		this.evaluationHistory.push({
			Time: timeStamp,
			roundedWilly: roundedWilly.toFixed(4),
			currentEMA: roundedEMA.toFixed(4),
			"Willy Slope": willySlope.toFixed(4),
			"EMA Slope": emaSlope.toFixed(4),
			"Was Willy Falling?": wasWillyFalling,
			"Crossover Just Happened": crossoverJustHappened,
			"Diff (Willy - EMA)": (roundedWilly - roundedEMA).toFixed(4),
			"✅ All Conditions Met": allConditionsMet
		});

		if (this.evaluationHistory.length > 50) {
			this.evaluationHistory = this.evaluationHistory.slice(-50);
		}

		console.clear();
		console.log('\n' + '*'.repeat(40));
		console.log('* SELL action triggered *');
		console.table(this.evaluationHistory);
		console.log('*'.repeat(40));

		if (allConditionsMet) {
			action = 'SELL';
			reason = `Reversal signal: Williams %R (${roundedWilly.toFixed(4)}) fell through EMA (${roundedEMA.toFixed(4)}) with slope confirmation.`;
		} else {
			action = 'HOLD';
			reason = `SELL conditions not met (Willy: ${roundedWilly.toFixed(4)}, EMA: ${roundedEMA.toFixed(4)}).`;
		}
		}

		const signal = {
			plugin: this.name,
			symbol: this.symbol,
			laction: this.lastSignalAction,
			tslactiondate: this.lastSignalTimestamp,
			laprice: this.lastSignalPrice,
			action,
			side: action,
			price,
			clientOrderId: this.clientOrderId, // This will be set in the signalProcessor.js
			williamsR: roundedWilly,
			ema: roundedEMA,
			reason,
			timestamp: t,
			config: {
				trendReq: this.williamsRData.trendReq,
				length: this.williamsRData.length,
				buyWilly: this.williamsRData.buyWilly,
				sellWilly: this.williamsRData.sellWilly,
				sellEmaThreshold: this.williamsRData.sellEmaThreshold,
				buyEmaThreshold: this.williamsRData.buyEmaThreshold
			}
		};

		if (action === this.lastSignalAction || action === 'interHOLD') {
		//if (action === 'interHOLD') {
			return {
				plugin: 'WilliamsRPlugin',
				symbol: this.symbol,
				laction: this.lastSignalAction,
				tslactiondate: t,
				laprice: this.lastSignalPrice,
				action: 'interHOLD',
				price,
				williamsR: roundedWilly,
				ema: roundedEMA,
				reason: 'No strong signal - intermediate HOLD',
				timestamp: t
			};
		}

		if (action === 'BUY' || action === 'SELL') {
			if (action === 'BUY') {
				this.clientOrderId = this.name.replace(/[^A-Z]/g, '') + Date.now().toString(16) + '_' + Math.floor(Math.random() * 9999 + 1).toString(16);
				signal.clientOrderId = this.clientOrderId; // Save for SELL to match with BUY
			}

			if (action === 'SELL'){
				signal.clientOrderId = this.clientOrderId || 'N/A'; // Use the same clientOrderId as BUY
			}

			this.lastSignalAction = action;
			this.lastSignalTimestamp = t;
			this.lastSignalPrice = price;
			
			logInfo(`[${this.name} - ${this.symbol}] Signal: ${signal.action} | Price: ${signal.price}, Williams %R: ${signal.williamsR.toFixed(4)}, EMA: ${signal.ema.toFixed(4)}`);
			logInfo(`<------------------------------------------------------------------------------------------------------------------------>`);
		}

		// Save for next slope/crossover evaluation
		this.prevWilly = roundedWilly;
		this.prevEMA = roundedEMA;

		return signal;
	} catch (error) {
		logError(`[${this.name} - ${this.symbol}] Error calculating Williams %R: ${error.message}`);
		const fallbackTimestamp = t || new Date().toISOString();
		return {
			plugin: 'WilliamsRPlugin',
			symbol: this.symbol,
			laction: this.lastSignalAction,
			tslactiondate: this.lastSignalTimestamp,
			laprice: this.lastSignalPrice,
			action: 'HOLD',
			price,
			williamsR: null,
			ema: null,
			reason: 'Error calculating indicator',
			timestamp: fallbackTimestamp
		};
	}
}




updateParams(options = {}) {
	console.log('[WilliamsRPlugin.updateParams] called with:', options);
	if (options.length !== undefined) {
		this.williamsRData.length = options.length;
		logInfo(`[${this.name} - ${this.symbol}] Length set to: ${options.length}`);
	}

	if (options.WS) {
		const baseUrl = options.WS;
		const params = new URLSearchParams();
		if (options.symbol) {
		  params.append('symbol', options.symbol);
		}
		if (options.duration) {
		  params.append('interval', options.duration);
		}
		if (options.limit) {
		  params.append('limit', options.limit);
		}
		this.klineWS = `${baseUrl}?${params.toString()}`;
	  } else if (options.klineWS) {
		this.klineWS = options.klineWS;
	  }

	if (options.emaLength !== undefined) {
		this.williamsRData.emaLength = options.emaLength;
		logInfo(`[${this.name} - ${this.symbol}] EMA Length set to: ${options.emaLength}`);
	}
	if (options.buyWilly !== undefined) {
		this.williamsRData.buyWilly = options.buyWilly;
		logInfo(`[${this.name} - ${this.symbol}] Buy Willy set to: ${options.buyWilly}`);
	}
	if (options.sellWilly !== undefined) {
		this.williamsRData.sellWilly = options.sellWilly;
		logInfo(`[${this.name} - ${this.symbol}] Sell Willy set to: ${options.sellWilly}`);
	}
	if (options.sellEmaThreshold !== undefined) {
		this.williamsRData.sellEmaThreshold = options.sellEmaThreshold;
		logInfo(`[${this.name} - ${this.symbol}] Sell EMA Threshold set to: ${options.sellEmaThreshold}`);
	}
	if (options.buyEmaThreshold !== undefined) {
		this.williamsRData.buyEmaThreshold = options.buyEmaThreshold;
		logInfo(`[${this.name} - ${this.symbol}] Buy EMA Threshold set to: ${options.buyEmaThreshold}`);
	}
	if (options.klineWS !== undefined) {
		this.klineWS = options.klineWS;
		logInfo(`[${this.name} - ${this.symbol}] klineWS set to: ${options.klineWS}`);
	}
	if (options.symbol !== undefined) {
		this.symbol = options.symbol;
		logInfo(`[${this.name} - ${this.symbol}] Symbol set to: ${options.symbol}`);
	}
}


startPlugin(klineWS) {
	if (klineWS) {
		this.klineWS = klineWS;
		logInfo(`[${this.name} - ${this.symbol}] Starting plugin with klineWS: ${this.klineWS}`);
		try {
			this.symbol = new URL(klineWS).searchParams.get('symbol') || this.symbol;
			logInfo(`[${this.name} - ${this.symbol}] Extracted symbol from klineWS: ${this.symbol}`);
		} catch (err) {
			logWarn(`[${this.name} - ${this.symbol}] Unable to parse symbol from klineWS: ${err.message}`);
		}
	}
	// Always initialize the WebSocket using the internal klineWS value.
	this.initializeWebSocket(this.klineWS);
}

}


module.exports = WilliamsRPlugin;
