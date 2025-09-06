// logger.js
const config = require('./config');
const fs = require('fs');
const path = require('path'); // Add this to handle absolute paths
// logger.js

let logCounter = 0;

/**
 * Logs messages with a specific level and timestamp.
 * @param {string} level - Log level (INFO, WARN, ERROR).
 * @param {string} message - Message to log.
 */
function logWithLevel(level, message) {
  logCounter++;
  const timestamp = new Date().toISOString();
  console.log(`[${logCounter}] [${timestamp}] [${level}] ${message}`);
}

function saveSignal(content) {
  console.log("[Logger Debug] Saving signal log entry:", content);

  // Use an absolute path to avoid issues with relative paths
  const logFilePath = path.resolve(__dirname, "saveSignal.log");
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${content}\n`;

  try {
    // Ensure the log file exists; create it with a header if not.
    if (!fs.existsSync(logFilePath)) {
      console.log("[Logger Debug] Log file does not exist. Creating a new one.");
      fs.writeFileSync(logFilePath, `Log file created at ${timestamp}\n`, { flag: 'w' });
    }
    fs.appendFileSync(logFilePath, logEntry);
    console.log("[Logger Debug] Log entry successfully written.");
  } catch (error) {
    console.error('[Logger Error] Error writing log:', error);
  }

  return logEntry;
}

function log(...args) {
  if (config.debug) {
    console.log(...args);
  }
}

function flush() {
  // If you buffer logs, implement flushing here.
  // For now, just output a flush notification.
  if (config.debug) {
    console.log("Flushing logs...");
  }
}

console.log("Logger module loaded:", module.exports);
// Export the logging functions for use in other files

module.exports = {
  log,
  flush,
  logInfo: (message) => logWithLevel('INFO', message),
  logWarn: (message) => logWithLevel('WARN', message),
  logError: (message) => logWithLevel('ERROR', message),
  saveSignal,
};
