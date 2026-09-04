// dump explain for the list query — paste into submission notes
import * as db from '../src/db';

async function main() {
  const database = await db.connect();
  const t = await database.collection('tenants').findOne({});
  if (!t) {
    console.error('seed first');
    process.exit(1);
  }

  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const filter = {
    tenantId: String(t._id),
    siteId: 'site_1',
    status: 'checked_in',
    createdAt: { $gte: start },
  };

  const plan = await database
    .collection('checkins')
    .find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(50)
    .explain('executionStats');

  const stats = (plan as { executionStats?: Record<string, number> }).executionStats || {};
  const qp = (plan as { queryPlanner?: { winningPlan?: unknown } }).queryPlanner;

  console.log(
    JSON.stringify(
      {
        filter,
        indexHint: 'list_by_site_status',
        ms: stats.executionTimeMillis,
        docsExamined: stats.totalDocsExamined,
        keysExamined: stats.totalKeysExamined,
        nReturned: stats.nReturned,
        winningPlan: qp?.winningPlan,
      },
      null,
      2
    )
  );

  await db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
