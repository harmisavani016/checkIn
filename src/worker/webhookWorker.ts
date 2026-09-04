import http from 'http';
import https from 'https';
import { URL } from 'url';
import logger from '../logger';
import * as db from '../db';
import * as redis from '../redis';
import { WEBHOOK_QUEUE_KEY, WEBHOOK_RETRY_KEY } from '../services/webhooks';
import { WebhookJob } from '../types';

const MAX_ATTEMPTS = 5;

function jitteredBackoffMs(attempt: number): number {
  const cap = 500 * Math.pow(2, attempt);
  return Math.floor(Math.random() * cap);
}

function postJson(
  urlStr: string,
  body: unknown,
  headers: Record<string, string>
): Promise<number> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch (err) {
      return reject(err);
    }

    const transport = url.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(body));
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': payload.length,
          ...headers,
        },
        timeout: 5000,
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode || 0));
      }
    );

    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end(payload);
  });
}

async function deliverWebhook(job: WebhookJob): Promise<boolean> {
  const log = logger.child({
    requestId: job.requestId,
    tenantId: job.tenantId,
    attempt: (job.attempts || 0) + 1,
  });

  try {
    const statusCode = await postJson(
      job.webhookUrl,
      { type: job.type, data: job.data, requestId: job.requestId },
      {
        'x-request-id': job.requestId || '',
        'x-tenant-id': job.tenantId || '',
      }
    );

    if (statusCode >= 200 && statusCode < 300) {
      log.info({ statusCode }, 'webhook delivered');
      return true;
    }

    log.warn({ statusCode }, 'webhook non-2xx');
    return false;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'webhook request failed');
    return false;
  }
}

async function recordPermanentFailure(job: WebhookJob, reason: string) {
  await db.getDb().collection('webhook_failures').insertOne({
    tenantId: job.tenantId,
    webhookUrl: job.webhookUrl,
    type: job.type,
    requestId: job.requestId,
    payload: job.data,
    reason,
    attempts: job.attempts,
    createdAt: new Date(),
    resolved: false,
  });
  logger.error({ requestId: job.requestId, reason }, 'webhook permanently failed');
}

async function processJob(raw: string) {
  let job: WebhookJob;
  try {
    job = JSON.parse(raw) as WebhookJob;
  } catch {
    return;
  }

  job.attempts = job.attempts || 0;
  const delivered = await deliverWebhook(job);
  if (delivered) return;

  job.attempts += 1;
  if (job.attempts >= MAX_ATTEMPTS) {
    await recordPermanentFailure(job, 'max_attempts');
    return;
  }

  const dueAt = Date.now() + jitteredBackoffMs(job.attempts);
  await redis.getRedis().zadd(WEBHOOK_RETRY_KEY, dueAt, JSON.stringify(job));
}

async function moveDueRetriesToQueue() {
  const client = redis.getRedis();
  const dueJobs = await client.zrangebyscore(WEBHOOK_RETRY_KEY, 0, Date.now(), 'LIMIT', 0, 20);

  for (const job of dueJobs) {
    const removed = await client.zrem(WEBHOOK_RETRY_KEY, job);
    if (removed) {
      await client.lpush(WEBHOOK_QUEUE_KEY, job);
    }
  }
}

async function run() {
  await db.connect();
  redis.connect();
  logger.info('webhook worker started');

  process.on('SIGTERM', () => {
    logger.info('webhook worker shutting down');
    setTimeout(async () => {
      await redis.close();
      await db.close();
      process.exit(0);
    }, 1500);
  });

  const client = redis.getRedis();
  for (;;) {
    try {
      await moveDueRetriesToQueue();
      const popped = await client.brpop(WEBHOOK_QUEUE_KEY, 2);
      if (popped) {
        await processJob(popped[1]);
      }
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'worker loop error');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
