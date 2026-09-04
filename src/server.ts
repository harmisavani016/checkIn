import http from 'http';
import config from './config';
import logger from './logger';
import * as db from './db';
import * as redis from './redis';
import { buildApp } from './app';

let server: http.Server | undefined;
let isShuttingDown = false;

async function main() {
  await db.connect();
  redis.connect();

  server = http.createServer(buildApp());
  server.listen(config.port, () => {
    logger.info({ port: config.port }, 'api listening');
  });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal }, 'graceful shutdown started');

  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
      setTimeout(resolve, 10_000).unref();
    });
  }

  try {
    await redis.close();
  } catch {
    /* already closing */
  }
  try {
    await db.close();
  } catch {
    /* already closing */
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
