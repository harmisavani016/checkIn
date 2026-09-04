// 50 tenants, 500k checkins. tenant[0] gets ~40%.
import { ObjectId } from 'mongodb';
import * as db from '../src/db';
import logger from '../src/logger';

const N_TENANTS = 50;
const N_ROWS = 500000;
const BATCH = 2000;

function key(i: number) {
  return 'nb_live_' + String(i).padStart(3, '0') + '_demo';
}

async function main() {
  const database = await db.connect();
  const tenantsCol = database.collection('tenants');
  const checkinsCol = database.collection('checkins');

  await tenantsCol.deleteMany({});
  await checkinsCol.deleteMany({});
  await database.collection('webhook_failures').deleteMany({});

  const tenants = [];
  for (let i = 1; i <= N_TENANTS; i++) {
    tenants.push({
      _id: new ObjectId(),
      name: 'Tenant ' + i,
      apiKey: key(i),
      webhookUrl: i === 1 ? 'http://127.0.0.1:9/hook' : null,
      active: true,
      createdAt: new Date(),
    });
  }
  await tenantsCol.insertMany(tenants);
  logger.info({ n: tenants.length, heavy: tenants[0].apiKey }, 'tenants');

  const now = Date.now();
  let n = 0;
  while (n < N_ROWS) {
    const size = Math.min(BATCH, N_ROWS - n);
    const batch = [];
    for (let j = 0; j < size; j++) {
      const idx = n + j;
      const t = idx < N_ROWS * 0.4 ? tenants[0] : tenants[1 + (idx % (N_TENANTS - 1))];
      const createdAt = new Date(now - (N_ROWS - idx) * 1000);
      const out = idx % 5 === 0;
      batch.push({
        tenantId: String(t._id),
        siteId: 'site_' + ((idx % 12) + 1),
        visitorName: 'Visitor ' + idx,
        visitorPhone: '9' + String(1000000000 + (idx % 899999999)).slice(0, 9),
        status: out ? 'checked_out' : 'checked_in',
        checkedInAt: createdAt,
        checkedOutAt: out ? new Date(createdAt.getTime() + 3600000) : null,
        createdAt,
        updatedAt: createdAt,
        meta: { seed: true },
      });
    }
    await checkinsCol.insertMany(batch, { ordered: false });
    n += size;
    if (n % 100000 === 0) logger.info({ n }, 'seed');
  }

  logger.info('seed done');
  await db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
