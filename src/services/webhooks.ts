import { getRedis } from '../redis';
import config from '../config';
import logger from '../logger';
import { WebhookJob } from '../types';

export const WEBHOOK_QUEUE_KEY = 'webhook:queue';
export const WEBHOOK_RETRY_KEY = 'webhook:retry';
export const IDEMPOTENCY_TTL_SECONDS = config.idempotencyTtlSeconds;

export function enqueueCheckinWebhook(job: WebhookJob): void {
  const payload = JSON.stringify({
    ...job,
    attempts: 0,
    enqueuedAt: Date.now(),
  });

  // Fire-and-forget so check-in latency does not wait on Redis/network
  getRedis()
    .lpush(WEBHOOK_QUEUE_KEY, payload)
    .catch((err: Error) => {
      logger.error({ err: err.message, requestId: job.requestId }, 'webhook enqueue failed');
    });
}

export function buildIdempotencyRedisKey(tenantId: string, idempotencyKey: string): string {
  return `idem:${tenantId}:${idempotencyKey}`;
}

// Backwards-compatible aliases used during the TS migration
export const QUEUE_KEY = WEBHOOK_QUEUE_KEY;
export const RETRY_KEY = WEBHOOK_RETRY_KEY;
