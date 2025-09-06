const winston = require('winston');
const path = require('path');
const fs = require('fs');

const createPluginLogger = (pluginName) => {
  const logDir = path.join(__dirname, '..', '..', '..', 'logs');
  const logFile = path.join(logDir, `${pluginName}.log`);

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      // This will only affect console output, not the file
    ),
    transports: [
      // Console: color and pretty
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
          winston.format.printf(
            info => `${info.timestamp} ${info.level}: ${info.message}`
          )
        )
      }),
      // File: JSON per line, easy for HTML/JS parsing and highlighting
      new winston.transports.File({
        filename: logFile,
        format: winston.format.combine(
          winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
          winston.format.json() // <-- JSON LINES!
        )
      })
    ]
  });

  // Accept objects as well as strings for advanced logging
  function safeLog(level, msg) {
    if (typeof msg === 'object') {
      logger.log(level, JSON.stringify(msg));
    } else {
      logger.log(level, msg);
    }
  }

  return {
    logInfo: (msg) => safeLog('info', msg),
    logWarn: (msg) => safeLog('warn', msg),
    logError: (msg) => safeLog('error', msg)
  };
};

module.exports = createPluginLogger;
