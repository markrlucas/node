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

// Expose specific logging functions
module.exports = {
    logInfo: (message) => logWithLevel('INFO', message),
    logWarn: (message) => logWithLevel('WARN', message),
    logError: (message) => logWithLevel('ERROR', message),
};

console.log("Logger module loaded:", module.exports);
// Export the logging functions for use in other files

