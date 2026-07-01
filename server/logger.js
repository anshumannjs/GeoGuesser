'use strict';

const pino = require('pino');

const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  },
  process.env.NODE_ENV === 'production'
    ? pino.destination({ dest: 1, sync: false }) // async stdout in prod
    : require('pino-pretty')({
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        ignore: 'pid,hostname',
      })
);

module.exports = logger;