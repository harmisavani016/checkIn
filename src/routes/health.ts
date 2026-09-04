import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { getRedis } from '../redis';

const router = Router();

// Liveness: process is up (even if deps are unhealthy)
router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Readiness: safe to send traffic only when Mongo + Redis respond
router.get('/ready', async (_req: Request, res: Response) => {
  const checks = { mongo: false, redis: false };

  try {
    await getDb().command({ ping: 1 });
    checks.mongo = true;
  } catch {
    checks.mongo = false;
  }

  try {
    checks.redis = (await getRedis().ping()) === 'PONG';
  } catch {
    checks.redis = false;
  }

  const ready = checks.mongo && checks.redis;
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    checks,
  });
});

export default router;
