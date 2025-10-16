const { createLogger, format, transports } = require('winston');

/**
 * Simple wrapper around winston that outputs structured JSON logs.  The log
 * level defaults to `debug` in non‑production environments and `info` in
 * production.  Each log record contains a timestamp and message.
 */
const logger = createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    format.errors({ stack: true }),
    format.json()
  ),
  transports: [new transports.Console()]
});

module.exports = logger;