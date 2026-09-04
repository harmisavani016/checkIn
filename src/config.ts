import fs from 'fs';
import path from 'path';

function loadEnvFile() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const config = {
  port: Number(process.env.PORT || 3000),
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/checkins',
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  logLevel: process.env.LOG_LEVEL || 'info',
  instanceId: process.env.INSTANCE_ID || 'local',
  rateLimit: {
    requestsPerSecond: 100,
    burst: 200,
  },
  idempotencyTtlSeconds: 24 * 60 * 60,
};

export default config;
