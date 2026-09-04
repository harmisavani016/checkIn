import { Db, MongoClient } from 'mongodb';
import config from './config';
import logger from './logger';

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connect(): Promise<Db> {
  if (db) return db;

  client = new MongoClient(config.mongoUri, { maxPoolSize: 50 });
  await client.connect();
  db = client.db();
  await ensureIndexes(db);
  logger.info('mongo connected');
  return db;
}

async function ensureIndexes(database: Db): Promise<void> {
  const checkins = database.collection('checkins');

  // Equality fields first, then sort/range on createdAt (ESR rule of thumb)
  await checkins.createIndex(
    { tenantId: 1, siteId: 1, status: 1, createdAt: -1, _id: -1 },
    { name: 'list_by_site_status' }
  );
  await checkins.createIndex(
    { tenantId: 1, createdAt: -1, _id: -1 },
    { name: 'list_by_tenant' }
  );
  // Redis caches idempotent responses; unique index is the race-condition backstop
  await checkins.createIndex(
    { tenantId: 1, idempotencyKey: 1 },
    {
      name: 'uniq_idem',
      unique: true,
      partialFilterExpression: { idempotencyKey: { $type: 'string' } },
    }
  );

  await database.collection('tenants').createIndex({ apiKey: 1 }, { unique: true });
  await database.collection('webhook_failures').createIndex({ tenantId: 1, createdAt: -1 });
}

export function getDb(): Db {
  if (!db) throw new Error('MongoDB is not connected yet');
  return db;
}

export async function close(): Promise<void> {
  if (!client) return;
  await client.close();
  client = null;
  db = null;
}
