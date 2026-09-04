import { Filter, MongoServerError, ObjectId } from 'mongodb';
import { getDb } from '../db';
import { getRedis } from '../redis';
import {
  enqueueCheckinWebhook,
  buildIdempotencyRedisKey,
  IDEMPOTENCY_TTL_SECONDS,
} from './webhooks';
import logger from '../logger';
import {
  CheckinDocument,
  CheckinResponse,
  CheckinStatus,
  TenantContext,
} from '../types';

function checkinsCollection() {
  return getDb().collection<CheckinDocument>('checkins');
}

function encodeCursor(doc: CheckinDocument): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: doc.createdAt.toISOString(),
      id: String(doc._id),
    })
  ).toString('base64url');
}

export function decodeCursor(
  raw?: string
): { createdAt: Date; _id: ObjectId } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString()) as {
      createdAt?: string;
      id?: string;
      t?: string;
      i?: string;
    };
    const createdAtRaw = parsed.createdAt || parsed.t;
    const idRaw = parsed.id || parsed.i;
    if (!createdAtRaw || !idRaw) return null;
    return { createdAt: new Date(createdAtRaw), _id: new ObjectId(idRaw) };
  } catch {
    return null;
  }
}

function toPublicCheckin(doc: CheckinDocument): CheckinResponse {
  return {
    id: String(doc._id),
    tenantId: doc.tenantId,
    siteId: doc.siteId,
    visitorName: doc.visitorName,
    visitorPhone: doc.visitorPhone || null,
    status: doc.status,
    checkedInAt: doc.checkedInAt,
    checkedOutAt: doc.checkedOutAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    meta: doc.meta || {},
  };
}

interface CreateCheckinBody {
  siteId: string;
  visitorName?: string;
  name?: string;
  visitorPhone?: string;
  phone?: string;
  meta?: Record<string, unknown>;
}

export async function createCheckin(
  tenant: TenantContext,
  body: CreateCheckinBody,
  idempotencyKey: string | null,
  requestId: string
) {
  const redis = getRedis();
  const cacheKey = idempotencyKey
    ? buildIdempotencyRedisKey(tenant.id, idempotencyKey)
    : null;

  if (cacheKey) {
    const cached = await redis.get(cacheKey);
    if (cached) {
      const previous = JSON.parse(cached) as { statusCode?: number; body: CheckinResponse };
      return {
        status: previous.statusCode || 200,
        body: previous.body,
        replayed: true,
      };
    }
  }

  const now = new Date();
  const document: CheckinDocument = {
    tenantId: tenant.id,
    siteId: body.siteId,
    visitorName: body.visitorName || body.name || 'unknown',
    visitorPhone: body.visitorPhone || body.phone || null,
    status: 'checked_in',
    checkedInAt: now,
    checkedOutAt: null,
    createdAt: now,
    updatedAt: now,
    meta: body.meta && typeof body.meta === 'object' ? body.meta : {},
  };
  if (idempotencyKey) {
    document.idempotencyKey = idempotencyKey;
  }

  let saved: CheckinDocument;
  try {
    const insertResult = await checkinsCollection().insertOne(document);
    saved = { ...document, _id: insertResult.insertedId };
  } catch (err: unknown) {
    const isDuplicate =
      err instanceof MongoServerError && err.code === 11000 && Boolean(idempotencyKey);

    if (isDuplicate && idempotencyKey) {
      const existing = await checkinsCollection().findOne({
        tenantId: tenant.id,
        idempotencyKey,
      });
      if (existing) {
        const responseBody = toPublicCheckin(existing);
        if (cacheKey) {
          await redis.set(
            cacheKey,
            JSON.stringify({ statusCode: 200, body: responseBody }),
            'EX',
            IDEMPOTENCY_TTL_SECONDS
          );
        }
        return { status: 200, body: responseBody, replayed: true };
      }
    }
    throw err;
  }

  const responseBody = toPublicCheckin(saved);
  if (cacheKey) {
    await redis.set(
      cacheKey,
      JSON.stringify({ statusCode: 201, body: responseBody }),
      'EX',
      IDEMPOTENCY_TTL_SECONDS
    );
  }

  if (tenant.webhookUrl) {
    enqueueCheckinWebhook({
      type: 'checkin.created',
      requestId,
      tenantId: tenant.id,
      webhookUrl: tenant.webhookUrl,
      data: responseBody,
    });
  }

  logger.info(
    { requestId, tenantId: tenant.id, checkinId: String(saved._id) },
    'checkin created'
  );

  return { status: 201, body: responseBody, replayed: false };
}

interface ListCheckinsQuery {
  siteId?: string;
  status?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: string;
}

export async function listCheckins(tenant: TenantContext, query: ListCheckinsQuery) {
  const filter: Filter<CheckinDocument> = { tenantId: tenant.id };

  if (query.siteId) filter.siteId = String(query.siteId);
  if (query.status) filter.status = String(query.status) as CheckinStatus;

  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(query.from);
    if (query.to) filter.createdAt.$lte = new Date(query.to);
  }

  const cursor = decodeCursor(query.cursor);
  if (cursor) {
    filter.$or = [
      { createdAt: { $lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, _id: { $lt: cursor._id } },
    ];
  }

  let limit = parseInt(query.limit || '', 10);
  if (!limit || limit < 1) limit = 50;
  if (limit > 100) limit = 100;

  const rows = await checkinsCollection()
    .find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .toArray();

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    data: page.map(toPublicCheckin),
    nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1]) : null,
  };
}

export async function checkout(tenant: TenantContext, checkinId: string) {
  if (!ObjectId.isValid(checkinId)) {
    return { status: 400, body: { error: 'bad_id' } };
  }

  const now = new Date();
  const updated = await checkinsCollection().findOneAndUpdate(
    {
      _id: new ObjectId(checkinId),
      tenantId: tenant.id,
      status: 'checked_in',
    },
    {
      $set: {
        status: 'checked_out',
        checkedOutAt: now,
        updatedAt: now,
      },
    },
    { returnDocument: 'after' }
  );

  if (updated) {
    return { status: 200, body: toPublicCheckin(updated) };
  }

  const existing = await checkinsCollection().findOne({
    _id: new ObjectId(checkinId),
    tenantId: tenant.id,
  });

  if (!existing) {
    return { status: 404, body: { error: 'not_found' } };
  }

  if (existing.status === 'checked_out') {
    return { status: 200, body: toPublicCheckin(existing) };
  }

  return {
    status: 409,
    body: { error: 'bad_state', status: existing.status },
  };
}
