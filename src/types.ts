import { ObjectId } from 'mongodb';

export type CheckinStatus = 'checked_in' | 'checked_out';

export interface TenantContext {
  id: string;
  name: string;
  webhookUrl: string | null;
}

export interface CheckinDocument {
  _id?: ObjectId;
  tenantId: string;
  siteId: string;
  visitorName: string;
  visitorPhone: string | null;
  status: CheckinStatus;
  checkedInAt: Date;
  checkedOutAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  meta: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface CheckinResponse {
  id: string;
  tenantId: string;
  siteId: string;
  visitorName: string;
  visitorPhone: string | null;
  status: CheckinStatus;
  checkedInAt: Date;
  checkedOutAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  meta: Record<string, unknown>;
}

export interface WebhookJob {
  type: string;
  requestId?: string;
  tenantId: string;
  webhookUrl: string;
  data: unknown;
  attempts?: number;
  enqueuedAt?: number;
}

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      tenant?: TenantContext;
    }
  }
}

export {};
