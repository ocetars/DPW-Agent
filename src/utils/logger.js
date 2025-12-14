/**
 * 简单的日志工具
 */

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

class Logger {
  constructor(name, level = 'INFO') {
    this.name = name;
    this.level = LOG_LEVELS[level] ?? LOG_LEVELS.INFO;
  }

  _log(level, levelName, ...args) {
    if (level >= this.level) {
      const timestamp = new Date().toISOString();
      const prefix = `[${timestamp}] [${levelName}] [${this.name}]`;
      console.log(prefix, ...args);
    }
  }

  debug(...args) {
    this._log(LOG_LEVELS.DEBUG, 'DEBUG', ...args);
  }

  info(...args) {
    this._log(LOG_LEVELS.INFO, 'INFO', ...args);
  }

  warn(...args) {
    this._log(LOG_LEVELS.WARN, 'WARN', ...args);
  }

  error(...args) {
    this._log(LOG_LEVELS.ERROR, 'ERROR', ...args);
  }
}

export function createLogger(name) {
  const level = process.env.DEBUG === 'true' ? 'DEBUG' : 'INFO';
  return new Logger(name, level);
}

export { Logger };

