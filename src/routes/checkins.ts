import { Router, Request, Response, NextFunction } from 'express';
import { requireTenant } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import * as checkinService from '../services/checkins';

const router = Router();
router.use(requireTenant, rateLimit);

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.body?.siteId) {
      return res.status(400).json({ error: 'siteId_required' });
    }

    const idempotencyHeader = req.headers['idempotency-key'];
    if (
      idempotencyHeader !== undefined &&
      (typeof idempotencyHeader !== 'string' || !idempotencyHeader.trim())
    ) {
      return res.status(400).json({ error: 'bad_idempotency_key' });
    }

    const result = await checkinService.createCheckin(
      req.tenant!,
      req.body,
      typeof idempotencyHeader === 'string' ? idempotencyHeader.trim() : null,
      req.requestId
    );

    if (result.replayed) {
      res.setHeader('x-idempotency-replayed', '1');
    }
    res.status(result.status).json(result.body);
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cursor = queryString(req.query.cursor);
    if (cursor && !checkinService.decodeCursor(cursor)) {
      return res.status(400).json({ error: 'bad_cursor' });
    }

    const from = queryString(req.query.from);
    const to = queryString(req.query.to);
    if (from && Number.isNaN(Date.parse(from))) {
      return res.status(400).json({ error: 'bad_from' });
    }
    if (to && Number.isNaN(Date.parse(to))) {
      return res.status(400).json({ error: 'bad_to' });
    }

    const result = await checkinService.listCheckins(req.tenant!, {
      siteId: queryString(req.query.siteId),
      status: queryString(req.query.status),
      from,
      to,
      cursor,
      limit: queryString(req.query.limit),
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/checkout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await checkinService.checkout(req.tenant!, req.params.id);
    res.status(result.status).json(result.body);
  } catch (err) {
    next(err);
  }
});

export default router;
