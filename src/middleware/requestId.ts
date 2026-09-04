import { Request, Response, NextFunction } from 'express';
import { nanoid } from 'nanoid';

export function attachRequestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers['x-request-id'] || req.headers['x-correlation-id'];
  req.requestId =
    typeof incoming === 'string' && incoming.length > 0 ? incoming : nanoid(12);
  res.setHeader('x-request-id', req.requestId);
  next();
}
