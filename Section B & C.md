# Section B — Diagnostics

### B1. Index Design

```javascript
db.checkins.createIndex(
  { tenantId: 1, siteId: 1, status: 1, createdAt: -1, _id: -1 },
  { name: 'list_by_site_status' }
)
```

Order is ESR: equality (`tenantId`, `siteId`, `status`), then range/sort (`createdAt`), then `_id` as a tie-break so cursor pagination matches the index and we avoid an in-memory SORT.

`tenantId` has to lead. Without it, a siteId/status index can still scan another tenant’s keys under load, and isolation becomes “hopefully the filter caught it” instead of “the index bounds start at this tenant.”

I would call the index correct when `explain("executionStats")` shows:

- winning plan is `IXSCAN` on this index (not `COLLSCAN`)
- no blocking `SORT` stage
- `nReturned ≈ totalDocsExamined` (not scanning a big prefix then discarding)
- index bounds actually pin `tenantId` / `siteId` / `status`

At 400 qps, if `docsExamined` is much larger than the page size, the index is wrong even if it “uses an index.”

### B2. Idempotency

The bug is almost always: credit first, then acknowledge. Provider times out, retries, credits again.

Fix at the DB level: **claim the provider `eventId` before any money moves.**

```javascript
db.webhook_events.createIndex({ eventId: 1 }, { unique: true })

// 1) claim
try {
  await db.webhook_events.insertOne({
    eventId,
    status: 'processing',
    createdAt: new Date(),
  })
} catch (err) {
  if (err.code === 11000) {
    // already claimed — do not credit again; return 200
    return
  }
  throw err
}

// 2) only the winner of the insert credits
await db.wallets.updateOne(
  { customerId },
  { $inc: { balance: amount } }
)

await db.webhook_events.updateOne(
  { eventId },
  { $set: { status: 'done', completedAt: new Date() } }
)
```

Unique index alone is not enough if you credit and then insert — a crash between those two steps still double-pays on retry. Insert/claim first. If you need “claim succeeded but credit failed,” store `status` and make retries resume safely (or wrap claim + credit in a transaction). Returning 2xx only after the claim is durable is what stops the provider’s retry storm from minting money.

### B3. Node Under Load

One Node process ≈ one JS thread. Seven idle cores means we are not using the machine; we are stuck on that one event loop.

Most likely:

1. **Synchronous CPU work on the request path** — big `JSON.parse`, crypto, compression, tight loops, sync fs. Confirm: CPU profile (`--cpu-prof` / clinic flame) + event-loop lag metric. Flat memory fits this (not a leak).
2. **Only one process under too much concurrency** — queueing on a single loop even if each handler is “async.” Confirm: request concurrency vs lag; run a second process / cluster and see p99 drop while per-process CPU falls.
3. **A hot route doing too much per request** — e.g. unbounded list, N+1 DB, heavy serialization. Confirm: break p99 by route; sample traces for the slow handlers.

I would not start with “add more memory.” Memory is flat and cores are idle — this is CPU/queueing on one thread, not RAM.

### B4. Zero-Downtime Migration

Goal: rename `mobile` → `phoneE164`, reformat 40M rows, stay online, rollback at every stage.

1. **Expand** — deploy code that reads `phoneE164` if present, else `mobile`. Dual-write: on update, set both (old format on `mobile`, E.164 on `phoneE164` where we can).
2. **Backfill** — batched updates per tenant (or by `_id` ranges), low parallelism, with progress checkpoints. Verify sample + counts per tenant before moving on.
3. **Contract reads** — deploy “read only `phoneE164`” after backfill completeness checks. Keep writing `mobile` for a while so rollback is still “flip reads back.”
4. **Contract writes** — stop writing `mobile`.
5. **Drop** — remove `mobile` only after a soak period.

Rollback: stages 1–3 roll back by reading `mobile` again (still populated). After stage 4, rollback needs a reverse backfill — so I would not drop until that risk is accepted. Never rewrite in place in one shot across 900 tenants.

### B5. Incident Triage

p50 flat + p99 200ms → 6s at 20:00 + normal CPU = a **tail** problem, not “the whole box is hot.”

Order I would look:

1. **Which routes / tenants / queries own the p99** — latency histogram by endpoint and tenant. One heavy tenant or one report query often explains a nightly spike.
2. **DB** — slow query log, lock/wait, pool wait time, index misses, collection scan on a growing day partition. CPU on app normal + tail latency often means we are waiting on Mongo/Redis/network, not computing.
3. **Scheduled work at 20:00** — cron, analytics rollups, backups, autovacuum-equivalents, invoice jobs. Correlate job start with the p99 cliff.
4. **Dependency latency** — outbound webhooks, payment, geolocation; only some requests take that path, so p50 stays calm.
5. **Cache / cold path** — nightly eviction or deploy causing a miss storm on a subset of keys.

I would pull one slow trace end-to-end before changing capacity. Scaling pods does not fix a 20:00 table scan.

### B6. Cost

30 minutes, bill 3× vs revenue +40%:

1. **Billing console** — cost by service for the last 8 months (absolute $, not % alone). Sort by increase, not by total.
2. **Biggest deltas first** — usually compute, managed DB, storage, egress, observability/logs. Open the top 1–2 only.
3. **Usage vs unit price** — did we buy more hours/GB, or did the unit price change / did we leave idle resources?
4. **Correlate with product** — data growth, new environments, forgotten staging, log retention, cross-AZ traffic.
5. **Quick wins list** — idle nodes, over-provisioned DB, debug logging left on, unscoped S3/log retention. Leave architecture redesign for after the 30 minutes.

I am looking for the surprise line item, not a perfect cost model.

---

# Section C — Architecture

### 1. Offline Capture and Sync

Orders are written locally on the tablet first. Flutter POS keeps SQLite for open tickets, unsynced completed orders, and the local invoice sequence. Network is optional for taking an order. With 20,000 outlets and 5–90 minute outages, anything that needs the cloud mid-sale will fail in real stores.

On reconnect, the tablet pushes unsynced orders in creation order. Each order carries a client UUID (`orderId`), `outletId`, local sequence, and frozen totals. Server upserts by `orderId`. Retries return the first write. That is how flaky Wi-Fi does not double-bill.

GST is frozen at capture: taxable value, CGST/SGST/IGST, amounts, invoice number. Sync may validate; it does not recompute. Corrections go through void/credit so the audit trail stays honest. Trade-off: no quiet “tax fix” later.

I would not use last-write-wins or CRDTs on money fields. Two offline devices at one outlet can both take orders (different UUIDs); invoice gaps get reconciled explicitly.

### 2. The 19:00 Spike

Dinner (19:00–22:30) is the hard window. The first ~3 minutes after 19:00 are worst: outlets reconnect and flush queues.

Sync API accepts fast and enqueues (SQS or equivalent). Workers write Mongo. POS acks when the payload is durably queued, not when every index is warm. Pre-warm workers before 19:00; do not bet the first three minutes on cold autoscaling.

Backpressure: if queue lag is high, slow bulk catch-up with retry-after; keep live tickets preferred. Tablets already buffer. Dashboards may lag seconds to a minute — better than losing orders. Keep analytics off the transactional Mongo during peak.

### 3. Dashboards

Do not run item-level dashboard aggregations on transactional Mongo.

After commit, emit `OrderCommitted`. A small consumer projects into a read model (Redis for “today / last 15m by outlet+item,” cheap daily rollups for history). Near-real-time for ops; GST filing still uses the order store / exports.

With six engineers I would not start with Kafka + Flink + a warehouse. Queue + consumer is enough until the write path is boring.

### 4. Data Model at 4 Billion Orders

Shard Mongo. Shard key `{ outletId, orderDate }` (or outlet + day bucket): POS and reconciliation are per outlet per day. Hashing only `orderId` turns every evening list into scatter-gather.

Trade-off: busy outlets skew shards — monitor and split hot ranges. Orders immutable after commit; voids/credits are new docs. Unique `(outletId, orderId)`; invoice uniqueness per outlet series. Shared cluster with `outletId` in every query — not 20,000 databases.

### 5. Month 1 vs. What I Would Defer

**Month 1 (six people — correctness and peak risk):**

- Offline SQLite capture + sync queue on Flutter
- Sync API + idempotent upsert by `orderId`
- Ingestion queue in front of Mongo for the 19:00 dump
- GST fields frozen; void/credit for corrections
- Basic metrics: sync fail, queue lag, Mongo write latency, duplicate hits
- Thin event → Redis/rollup for outlet/item dashboard
- Runbooks for queue backup and outlet offline > 90 min

**Deliberately defer for a year:**

- Multi-region active-active
- Full warehouse / heavy stream processing
- Cross-outlet real-time inventory
- Fancy shard rebalancing automation
- MDM beyond basics
- Microservice sprawl (billing, catalog, loyalty as separate services)

None of that ships food or protects GST in month 1. Extra moving parts are on-call load on a small budget. Make the write path durable, unique, and fiscally correct under peak; polish analytics later.

### Architecture diagram

```
[Offline]
Flutter POS --> SQLite (orders + invoice seq)
                 | reconnect / retry
                 v
            Sync API ----ack----> POS
                 |
                 v
          Ingestion queue  <-- backpressure / retry-after
                 |
                 v
       Worker (idempotent upsert by orderId)
                 |
                 +--> MongoDB (sharded outletId+date)
                 |
                 +--> OrderCommitted --> projector --> Redis/rollups --> React

Idempotency + GST freeze: sync/worker
Reconciliation: server ack flips local synced; duplicates ignored by orderId
```
