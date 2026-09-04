import { Request, Response, NextFunction } from 'express';
import { getRedis } from '../redis';
import config from '../config';

// Shared token bucket across API instances (state lives in Redis, not process memory)
const TOKEN_BUCKET_SCRIPT = `
local tokensKey = KEYS[1]
local timestampKey = KEYS[2]
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local tokens = tonumber(redis.call('GET', tokensKey))
local lastRefill = tonumber(redis.call('GET', timestampKey))
if tokens == nil then
  tokens = burst
  lastRefill = now
end

tokens = math.min(burst, tokens + math.max(0, now - lastRefill) * rate)

local allowed = 0
local retryAfter = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retryAfter = math.ceil((1 - tokens) / rate)
end

redis.call('SET', tokensKey, tokens)
redis.call('SET', timestampKey, now)
redis.call('EXPIRE', tokensKey, 60)
redis.call('EXPIRE', timestampKey, 60)
return { allowed, math.floor(tokens), retryAfter }
`;

export async function rateLimit(req: Request, res: Response, next: NextFunction) {
  if (!req.tenant) return next();

  try {
    const redis = getRedis();
    const result = (await redis.eval(
      TOKEN_BUCKET_SCRIPT,
      2,
      `rl:${req.tenant.id}:tok`,
      `rl:${req.tenant.id}:ts`,
      config.rateLimit.requestsPerSecond,
      config.rateLimit.burst,
      Date.now() / 1000
    )) as [number, number, number];

    const allowed = Number(result[0]) === 1;
    const remaining = Math.max(0, Number(result[1]));

    res.setHeader('x-ratelimit-limit', String(config.rateLimit.requestsPerSecond));
    res.setHeader('x-ratelimit-remaining', String(remaining));

    if (!allowed) {
      const retryAfter = Math.max(1, Number(result[2]));
      res.setHeader('retry-after', String(retryAfter));
      return res.status(429).json({ error: 'rate_limited', retryAfter });
    }

    next();
  } catch {
    // Intentionally fail-open when Redis is unavailable (take-home trade-off; not prod-safe)
    next();
  }
}
