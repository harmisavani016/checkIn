import pino from 'pino';
import config from './config';

const logger = pino({
  level: config.logLevel,
  base: {
    service: 'checkin-api',
    instance: config.instanceId,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export default logger;
