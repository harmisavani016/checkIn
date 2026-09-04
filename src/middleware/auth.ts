import { Request, Response, NextFunction } from 'express';
import { getDb } from '../db';
import { TenantContext } from '../types';

export async function requireTenant(req: Request, res: Response, next: NextFunction) {
  try {
    let apiKey = req.headers['x-api-key'] || req.headers.authorization;
    if (!apiKey || typeof apiKey !== 'string') {
      return res.status(401).json({ error: 'missing_api_key' });
    }

    if (apiKey.toLowerCase().startsWith('bearer ')) {
      apiKey = apiKey.slice(7).trim();
    }

    const tenant = await getDb().collection('tenants').findOne(
      { apiKey, active: { $ne: false } },
      { projection: { name: 1, webhookUrl: 1 } }
    );

    if (!tenant) {
      return res.status(401).json({ error: 'invalid_api_key' });
    }

    const context: TenantContext = {
      id: String(tenant._id),
      name: String(tenant.name ?? ''),
      webhookUrl: typeof tenant.webhookUrl === 'string' ? tenant.webhookUrl : null,
    };

    req.tenant = context;
    next();
  } catch (err) {
    next(err);
  }
}
