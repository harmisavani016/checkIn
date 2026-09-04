import express, { Request, Response, NextFunction } from 'express';
import pinoHttp from 'pino-http';
import logger from './logger';
import { attachRequestId } from './middleware/requestId';
import healthRoutes from './routes/health';
import checkinRoutes from './routes/checkins';

export function buildApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(attachRequestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as Request).requestId,
      customProps: (req) => ({
        requestId: (req as Request).requestId,
        tenantId: (req as Request).tenant?.id,
      }),
      serializers: {
        req(incoming) {
          return { method: incoming.method, url: incoming.url };
        },
        res(outgoing) {
          return { statusCode: outgoing.statusCode };
        },
      },
    })
  );

  app.use(healthRoutes);
  app.use('/v1/checkins', checkinRoutes);

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err: err.message, requestId: req.requestId }, 'unhandled error');
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal', requestId: req.requestId });
    }
  });

  return app;
}
