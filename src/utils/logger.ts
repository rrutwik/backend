import { existsSync, mkdirSync } from 'fs';
import winston from 'winston';
import winstonDaily from 'winston-daily-rotate-file';
import { LOG_DIR, NODE_ENV } from '@config';
import { Logger } from 'winston';
import { StreamOptions } from 'morgan';
import path from 'path';

// logs dir
const logDir: string = LOG_DIR;

if (!existsSync(logDir)) {
  mkdirSync(logDir);
}

// Get the file name and line number
const getCallerInfo = (): string => {
  const stack = new Error().stack.split('\n');
  // The actual caller will be the 4th line in the stack trace
  const callerLine = stack[3] || '';
  const match = callerLine.match(/\/([^/]+\.[^:]+):(\d+):(\d+)/) || [];
  if (match.length >= 4) {
    const fileName = path.basename(match[1]);
    const lineNumber = match[2];
    return `${fileName}:${lineNumber}`;
  }
  return '';
};

/*
 * Log Level
 * error: 0, warn: 1, info: 2, http: 3, verbose: 4, debug: 5, silly: 6
 */
// Override with LOG_LEVEL env. Production defaults to 'info' so per-event debug
// logging doesn't hit disk on every socket message / cron tick.
const LOG_LEVEL: string = process.env.LOG_LEVEL || (NODE_ENV === 'production' ? 'info' : 'debug');

const logger: Logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss',
    }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  transports: [
    // debug log setting
    new winstonDaily({
      level: 'debug',
      datePattern: 'YYYY-MM-DD',
      dirname: logDir + '/debug',
      filename: `%DATE%.log`,
      maxFiles: 30,
      json: true,
      zippedArchive: true,
    }),
    // error log setting
    new winstonDaily({
      level: 'error',
      datePattern: 'YYYY-MM-DD',
      dirname: logDir + '/error',
      filename: `%DATE%.log`,
      maxFiles: 30,
      handleExceptions: true,
      json: true,
      zippedArchive: true,
    })
  ],
});

// If we're not in production then log to the `console` with the format:
// `${info.level}: ${info.message} JSON.stringify({ ...rest }) `
if (NODE_ENV === 'production') {
  logger.add(new winston.transports.Console({
    level: "error",
    format: winston.format.combine(winston.format.splat(), winston.format.colorize())
  }));
} else {
  logger.add(new winston.transports.Console({
    level: "debug",
    format: winston.format.combine(winston.format.splat(), winston.format.colorize())
  }));
}

// Create a custom logger that includes the caller info.
// The caller lookup builds a stack trace, so skip it entirely when the level is disabled.
type LogFn = (message: string, ...meta: any[]) => void;
const makeLogFn = (level: 'error' | 'warn' | 'info' | 'debug'): LogFn => (message, ...meta) => {
  if (!logger.isLevelEnabled(level)) return;
  logger[level](message, { caller: getCallerInfo(), ...meta });
};

const customLogger = {
  error: makeLogFn('error'),
  warn: makeLogFn('warn'),
  info: makeLogFn('info'),
  debug: makeLogFn('debug'),
};

const stream: StreamOptions = {
  write: (message: string) => {
    customLogger.info(message.trim());
  },
};

export { customLogger as logger, stream };
