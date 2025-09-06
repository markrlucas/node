// websockets/klineClient.js
const WebSocket = require('ws');
const config = require('../config');
const pm2events = require('./pm2events');

let latestPrice = 0;
let previousCandleClose = 0;
let symbol = null

function initializeKlineWebSocket() {
  const klineSocket = new WebSocket(config.klineWS);
  klineSocket.onopen = () => {
    console.log('Connected to kline stream.');
  };
  klineSocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      //console.log("Kline data received:", JSON.stringify(data));
      
      if (data.e === "kline") {
        
        const kline = data.k;
        // kline.x is true when the candle is closed.
        if (kline.x === true) {
          // When a candle closes, update previousCandleClose and set latestPrice from the candle.
          previousCandleClose = latestPrice;
          latestPrice = parseFloat(kline.c);
          symbol = kline.s;
          
        } else {
          // During an open/in-progress candle, update latestPrice but keep the previous close intact.
          latestPrice = parseFloat(kline.c);
          
        }

        pm2events.send('signal', 'price', { 
          symbol: symbol,
          latestPrice: latestPrice, 
          previousPrice: previousCandleClose, 
          difference: (latestPrice - previousCandleClose).toFixed(4)
        });
      }
    } catch (err) {
      console.error("Error parsing kline data:", err);
    }
  };
  klineSocket.onerror = (error) => {
    console.error("Kline WebSocket Error:", error);
  };
  klineSocket.onclose = () => {
    console.warn("Kline WebSocket closed. Reconnecting in 5 seconds...");
    setTimeout(() => initializeKlineWebSocket(), 5000);
  };
}


// Returns an object with the previous candle's close, the current latest price, and the difference.
function getCandlePriceRange() {
  if (previousCandleClose === 0) return null; // No previous candle available.
  return {
    previousClose: previousCandleClose,
    latestClose: latestPrice,
    difference: latestPrice - previousCandleClose
  };
}

if (require.main === module) {
  initializeKlineWebSocket(); // Initialize the WebSocket connection when this script is run directly (e.g., with pm2).
}

module.exports = { initializeKlineWebSocket, getCandlePriceRange };
