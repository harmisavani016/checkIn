import Redis from 'ioredis';
import config from './config';
import logger from './logger';

let redis: Redis | null = null;

export function connect(): Redis {
  if (redis) return redis;

  redis = new Redis(config.redisUrl, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });

  redis.on('error', (err) => {
    logger.error({ err: err.message }, 'redis error');
  });

  return redis;
}

export function getRedis(): Redis {
  if (!redis) throw new Error('Redis is not connected yet');
  return redis;
}

export async function close(): Promise<void> {
  if (!redis) return;
  await redis.quit();
  redis = null;
}
