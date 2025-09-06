#!/usr/bin/env node
/**
 * binanceBackfill.js
 *
 * Usage:
 *   Normal Update Mode (incremental update using existing data):
 *     node binanceBackfill.js <symbol> [dataFilePath]
 *
 *   Extended Backfill Mode (re-fetch a fixed amount of historical data, e.g. 6 hours):
 *     node binanceBackfill.js <symbol> <backfillHours> [dataFilePath]
 *
 *   Count mode (count candles since last rotate period):
 *     node binanceBackfill.js count <symbol> <dataFilePath>
 *
 *   Aggregated Count mode (count aggregated 1m candles):
 *     node binanceBackfill.js count1m <symbol> <dataFilePath>
 *
 * This version always uses real data from Binance.
 * - In normal mode, it fills internal gaps and then appends data from the last candle to now.
 * - In extended mode, it fetches candles covering exactly the last X hours (e.g. 6 hours)
 *   from (now - X hours) to now.
 *
 * The update process is scheduled to run every 60 seconds.
 * 
 * To run this script as a scheduled task using PM2:
 * pm2 start ./binanceBackfill.js -n "Backfill <QUOTEBASE>"  --cron-restart "0 0 * * *" -- <QUOTEBASE>
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // For Node.js versions <18, ensure you install node-fetch@2

// Get command-line arguments.
const args = process.argv.slice(2);

if (args.length < 1) {
  console.error('Usage:\n  node binanceBackfill.js <symbol> [backfillHours] [dataFilePath]\n  Count: node binanceBackfill.js count <symbol> <dataFilePath>\n  Aggregated Count: node binanceBackfill.js count1m <symbol> <dataFilePath>');
  process.exit(1);
}

// Determine mode.
const modeArg = args[0].toLowerCase();
let isCountMode = modeArg === 'count';
let isCount1mMode = modeArg === 'count1m';

let providedSymbol, symbol, backfillHours, dataFilePath, dataIndexPath;
if (isCountMode || isCount1mMode) {
  if (args.length < 3) {
    console.error(`Usage for ${modeArg} mode: node binanceBackfill.js ${modeArg} <symbol> <dataFilePath>`);
    process.exit(1);
  }
  providedSymbol = args[1]; // as provided
  symbol = providedSymbol.toUpperCase(); // for Binance API
  dataFilePath = args[2];
} else {
  // Update/backfill mode.
  providedSymbol = args[0]; // use as provided
  symbol = providedSymbol.toUpperCase(); // for API calls
  if (args.length === 1) {
    // Only symbol provided; generate the file path based on today's date using lower case.
    const today = new Date();
    const dd = String(today.getDate()).padStart(2, '0');
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const yyyy = today.getFullYear();
    dataFilePath = `./jsons/${providedSymbol.toLowerCase()}-kline.json`;
    dataIndexPath = `./jsons/${providedSymbol.toLowerCase()}-index.json`;
  } else if (args.length === 2) {
    // Could be either normal mode (if second argument is a file path) or extended mode if the value is numeric.
    if (!isNaN(args[1])) {
      backfillHours = parseInt(args[1], 10);
      // Generate file path as before.
      const today = new Date();
      const dd = String(today.getDate()).padStart(2, '0');
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const yyyy = today.getFullYear();
      dataFilePath = `./jsons/${providedSymbol.toLowerCase()}-kline.json`;
    } else {
      dataFilePath = args[1];
    }
  } else if (args.length >= 3) {
    backfillHours = parseInt(args[1], 10);
    dataFilePath = args[2];
  } else {
    console.error('Insufficient arguments for backfill mode.');
    process.exit(1);
  }
}

// Ensure dataIndexPath is initialized correctly in all cases.
if (!dataIndexPath) {
  dataIndexPath = `./jsons/${providedSymbol.toLowerCase()}-index.json`;
}

log(`Running backfill for symbol (API): ${symbol}`);
log(`Using data file: ${dataFilePath}`);
if (backfillHours !== undefined) {
  log(`Extended backfill mode: Fetching the last ${backfillHours} hour(s) of data.`);
}

/**
 * Logs a message with a timestamp.
 */
function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

/**
 * Sanitize the JSON text.
 */
function sanitizeJSON(text) {
  const fixes = [];
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.replace(/^\ufeff/, '');
    fixes.push('Removed BOM.');
  }
  let originalText = text;
  text = text.replace(/^\s*\[\]\s*/, '');
  if (text !== originalText) fixes.push('Removed leading empty array.');
  const trailingCommaRegex = /,(\s*[\]}])/g;
  if (trailingCommaRegex.test(text)) {
    text = text.replace(trailingCommaRegex, '$1');
    fixes.push('Removed trailing commas.');
  }
  if (text.indexOf('][') !== -1) {
    text = text.replace(/\]\s*\[/g, ',');
    fixes.push('Merged multiple arrays.');
  }
  text = text.trim();
  if (!text.startsWith('[')) {
    text = '[' + text;
    fixes.push('Added missing opening bracket.');
  }
  if (!text.endsWith(']')) {
    text = text + ']';
    fixes.push('Added missing closing bracket.');
  }
  return { sanitizedText: text, fixes };
}

/**
 * Reads, sanitizes, and parses the JSON file.
 * If the file does not exist, returns an empty array.
 */
function readAndSanitizeJSON(filePath) {
  let rawText = '';
  if (!fs.existsSync(filePath)) {
    log(`File ${filePath} does not exist. Treating as empty.`);
    return [];
  }
  try {
    rawText = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    log(`Error reading file ${filePath}: ${err.message}`);
    process.exit(1);
  }
  const { sanitizedText, fixes } = sanitizeJSON(rawText);
  if (fixes.length > 0) {
    fixes.forEach(fix => log(`SANITIZE: ${fix}`));
  } else {
    log('SANITIZE: No issues detected.');
  }
  let parsed;
  try {
    parsed = JSON.parse(sanitizedText);
  } catch (err) {
    log(`Error parsing JSON: ${err.message}`);
    log(`Snippet: ${sanitizedText.substr(0, 50)}...`);
    try {
      const JSON5 = require('json5');
      parsed = JSON5.parse(sanitizedText);
      log('JSON5 parsing succeeded. Rewriting file.');
      fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2));
    } catch (err2) {
      log(`Error with JSON5 parsing: ${err2.message}`);
      process.exit(1);
    }
  }
  return parsed;
}

/**
 * Writes the JSON data (array) to disk.
 */
function writeJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    log(`Updated file: ${filePath}`);
  } catch (err) {
    log(`Error writing file: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Aggregates 1-second candles into 1-minute candles.
 */
function aggregateToOneMinute(candles) {
  const groups = {};
  candles.forEach(candle => {
    const minute = Math.floor(candle.k.t / 60000) * 60000;
    if (!groups[minute]) groups[minute] = [];
    groups[minute].push(candle.k);
  });
  return Object.keys(groups)
    .sort((a, b) => a - b)
    .map(minute => {
      const group = groups[minute];
      const openCandle = group[0];
      const closeCandle = group[group.length - 1];
      return {
        e: 'kline',
        E: Date.now(),
        s: openCandle.s,
        k: {
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
        }
      };
    });
}

/**
 * For any gap between two consecutive candles, fetch missing data from Binance.
 */
async function fillInternalGaps(candles, symbol) {
  let filledCandles = [];
  candles.sort((a, b) => a.k.t - b.k.t);
  for (let i = 0; i < candles.length - 1; i++) {
    const current = candles[i];
    const next = candles[i + 1];
    filledCandles.push(current);
    if (current.k.t + 1000 < next.k.t) {
      const gapStart = current.k.t + 1000;
      const gapEnd = next.k.t - 1;
      log(`Gap detected between ${new Date(current.k.t).toLocaleString('en-GB')} and ${new Date(next.k.t).toLocaleString('en-GB')}. Fetching missing data.`);
      const missing = await fetchMissingKlines(symbol, gapStart, gapEnd);
      if (missing.length > 0) {
        filledCandles = filledCandles.concat(missing);
      } else {
        log(`Warning: No data returned for gap ${new Date(gapStart).toLocaleString('en-GB')} - ${new Date(gapEnd).toLocaleString('en-GB')}.`);
      }
    }
  }
  filledCandles.push(candles[candles.length - 1]);
  filledCandles.sort((a, b) => a.k.t - b.k.t);
  return filledCandles;
}

/**
 * Fetch missing klines from Binance for the given symbol between startTime and endTime.
 * Note: Binance returns at most 500 candles per request.
 */
async function fetchMissingKlines(symbol, startTime, endTime) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1s&startTime=${startTime}&endTime=${endTime}`;
  log(`Fetching missing candles from Binance: ${url}`);
  try {
    const response = await fetch(url);
    if (!response.ok) {
      log(`Error fetching data: ${response.statusText}`);
      return [];
    }
    const data = await response.json();
    return data.map(item => {
      const openTime = item[0];
      const closeTime = item[6];
      return {
        e: 'kline',
        E: Date.now(),
        s: symbol,
        k: {
          t: openTime,
          T: closeTime,
          s: symbol,
          i: '1s',
          f: 0,
          L: 0,
          o: item[1],
          c: item[4],
          h: item[2],
          l: item[3],
          v: parseFloat(item[5]),
          n: 0,
          x: true,
          q: "0",
          V: "0",
          Q: "0",
          B: "0"
        }
      };
    });
  } catch (err) {
    log(`Error in fetchMissingKlines: ${err.message}`);
    return [];
  }
}

/**
 * Update mode.
 *
 * - In normal mode (no backfillHours provided): Uses existing file data,
 *   fills internal gaps and then fetches data from the last candle to now.
 *
 * - In extended mode (backfillHours provided): Re-fetches the last X hours of data,
 *   i.e. from (now - backfillHours) to now.
 */
async function updateData(symbol, dataFilePath) {
  const currentTime = Date.now();
  let candleData = [];
  let lastCandleTime = null;

  // Check if the index file exists and read the last updated minute.
  if (fs.existsSync(dataIndexPath)) {
    try {
      const indexData = JSON.parse(fs.readFileSync(dataIndexPath, 'utf8'));
      lastCandleTime = indexData.lastCandleTime;
      log(`Last updated minute from index: ${new Date(lastCandleTime).toLocaleString('en-GB')}`);
    } catch (err) {
      log(`Error reading index file: ${err.message}`);
    }
  }

  if (backfillHours !== undefined) {
    // Extended mode: fetch a full historical period covering the last X hours.
    const startTime = currentTime - backfillHours * 3600 * 1000;
    log(`Extended mode: Fetching data from ${new Date(startTime).toLocaleString('en-GB')} to ${new Date(currentTime).toLocaleString('en-GB')}.`);
    let fetchStart = startTime;
    while (fetchStart < currentTime) {
      const batchEnd = Math.min(fetchStart + 500 * 1000, currentTime); // 500 candles at 1s interval = 500 seconds.
      const batch = await fetchMissingKlines(symbol, fetchStart, batchEnd);
      if (batch.length === 0) break;
      candleData = candleData.concat(batch);
      fetchStart = batch[batch.length - 1].k.t + 1000;
      log(`Fetched ${batch.length} candles from ${new Date(fetchStart).toLocaleString('en-GB')} to ${new Date(batchEnd).toLocaleString('en-GB')}.`);
      if (batch.length < 500) break;
    }
    if (candleData.length === 0) {
      log("Error: Unable to fetch extended data from Binance. Exiting.");
      process.exit(1);
    }
    log(`Extended mode: Fetched a total of ${candleData.length} candles.`);
    writeJSON(dataFilePath, candleData);
    const indexData = { lastCandleTime: candleData[candleData.length - 1].k.t };
    fs.writeFileSync(dataIndexPath, JSON.stringify(indexData, null, 2));
    log(`Index updated with last candle timestamp: ${indexData.lastCandleTime}`);
    process.exit(0); // Exit after completing extended mode
  } else {
    // Normal update mode.
    candleData = readAndSanitizeJSON(dataFilePath);
    if (!Array.isArray(candleData) || candleData.length === 0) {
      const defaultStartTime = lastCandleTime || (currentTime - 3600 * 1000); // Use lastCandleTime or past 1 hour
      log(`File is empty or no data. Fetching initial data from ${new Date(defaultStartTime).toLocaleString('en-GB')} to ${new Date(currentTime).toLocaleString('en-GB')}.`);
      const initialCandles = await fetchMissingKlines(symbol, defaultStartTime, currentTime);
      if (initialCandles.length === 0) {
        log("Error: Unable to fetch initial data from Binance. Exiting.");
        process.exit(1);
      }
      candleData = initialCandles;
      log(`Fetched ${initialCandles.length} initial candles.`);
    }
    candleData.sort((a, b) => a.k.t - b.k.t);
    candleData = await fillInternalGaps(candleData, symbol);
    let lastCandle = candleData[candleData.length - 1];
    while (lastCandle.k.t + 1000 < currentTime) {
      log(`Fetching data from ${new Date(lastCandle.k.t + 1000).toLocaleString('en-GB')} to ${new Date(currentTime).toLocaleString('en-GB')}.`);
      const missing = await fetchMissingKlines(symbol, lastCandle.k.t + 1000, currentTime);
      if (missing.length === 0) {
        log("No new candles fetched from Binance for the missing period.");
        break;
      }
      candleData = candleData.concat(missing);
      candleData.sort((a, b) => a.k.t - b.k.t);
      lastCandle = candleData[candleData.length - 1];
      log(`Fetched ${missing.length} additional candles. New last candle timestamp: ${lastCandle.k.t}`);
      if (missing.length < 500) break;
    }
    writeJSON(dataFilePath, candleData);
    const indexData = { lastCandleTime: candleData[candleData.length - 1].k.t };
    fs.writeFileSync(dataIndexPath, JSON.stringify(indexData, null, 2));
    log(`Index updated with last candle timestamp: ${indexData.lastCandleTime}`);
  }
}

/**
 * Count mode: Count candles since last rotate period.
 */
function countObjectsSinceLastRotate(filePath) {
  const baseName = path.basename(filePath, '.json');
  const tokens = baseName.split('-');
  if (tokens.length < 4) {
    log(`Filename ${baseName} does not match expected pattern.`);
    process.exit(1);
  }
  const day = parseInt(tokens[1], 10);
  const month = parseInt(tokens[2], 10) - 1;
  const year = parseInt(tokens[3], 10);
  const fileDate = new Date(year, month, day);
  const lastRotate = new Date(fileDate);
  lastRotate.setDate(fileDate.getDate() - 1);
  lastRotate.setHours(23, 59, 59, 999);
  log(`Assuming last rotate period timestamp is: ${lastRotate.toISOString()}`);
  const data = readAndSanitizeJSON(filePath);
  if (!Array.isArray(data)) {
    log(`Data in file ${filePath} is not an array. Exiting.`);
    process.exit(1);
  }
  const count = data.filter(item => item.k.t >= lastRotate.getTime()).length;
  log(`Found ${count} candle(s) since the last rotate period.`);
}

/**
 * Aggregated Count mode: Aggregate 1-second candles into 1-minute candles and count them.
 */
function countAggregatedCandles(filePath) {
  const data = readAndSanitizeJSON(filePath);
  if (!Array.isArray(data)) {
    log(`Data in file ${filePath} is not an array. Exiting.`);
    process.exit(1);
  }
  const aggregated = aggregateToOneMinute(data);
  log(`There are ${aggregated.length} aggregated 1m candle(s) in the data.`);
}

/**
 * Rotate daily files for each symbol.
 */
function rotateDailyFiles(symbols) {
  const now = new Date();
  const ukDate = now.toLocaleDateString('en-GB').replace(/\//g, '-');
  symbols.forEach(symbol => {
    const expectedFile = path.join(DATA_DIR, `${symbol.toLowerCase()}-${ukDate}.json`);
    if (!fs.existsSync(expectedFile)) {
      log(`Rotating daily file for ${symbol}.`);
      fs.writeFile(expectedFile, JSON.stringify([]), (err) => {
        if (err) {
          log(`Error creating new daily file during rotation for ${symbol}: ${err.message}`);
        } else {
          log(`Daily rotation: started new file for ${symbol} on ${ukDate}`);
        }
      });
    }
  });
}

/**
 * Main execution.
 */
async function main() {
  if (isCountMode) {
    countObjectsSinceLastRotate(dataFilePath);
    return;
  }
  if (isCount1mMode) {
    countAggregatedCandles(dataFilePath);
    return;
  }
  
  await updateData(symbol, dataFilePath);
  rotateDailyFiles([symbol]); // Rotate files after updating data
}

/**
 * Run the update process immediately, then every 60 seconds.
 */
async function runUpdate() {
  try {
    await updateData(symbol, dataFilePath);
  } catch (err) {
    log(`Error during update: ${err.message}`);
  }
}

if (backfillHours === undefined) {
  runUpdate();
  setInterval(runUpdate, 60 * 1000);
} else {
  main();
}
