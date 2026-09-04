# Check-in API — Submission Notes

## 1. How to run it

One command (Docker):

```bash
docker compose up --build -d && docker compose exec api node dist/scripts/seed.js
```

API: `http://localhost:3000`  
Demo key: `nb_live_001_demo`

```bash
curl http://localhost:3000/ready
curl -X POST http://localhost:3000/v1/checkins \
  -H "content-type: application/json" \
  -H "x-api-key: nb_live_001_demo" \
  -H "idempotency-key: demo-1" \
  -d "{\"siteId\":\"site_1\",\"visitorName\":\"Ada\"}"
```

Optional: `docker compose --profile multi up --build -d` starts two extra API instances on 3001/3002 (same Mongo/Redis).

Without Docker: Mongo + Redis on localhost, copy `.env.example` → `.env`, then `npm install && npm run build && npm start` (and `npm run worker` in another terminal). Seed with `npm run seed`.

Scripts used below: `npm run explain`, `npm run load`.

---

## 2. Load test results

Machine: local Windows, single API process, MongoDB local, Redis local. Seeded DB: **50 tenants / 500k checkins**. Default rate limit: **100 rps / burst 200**.

**Under the rate-limit budget** (`N=180`, `C=10`):

```json
{
  "N": 180,
  "ok": 180,
  "fail": 0,
  "C": 10,
  "sec": 0.43,
  "rps": 415.7,
  "p50": 22.5,
  "p95": 31.8,
  "p99": 34.4
}
```

**Default script** (`N=500`, `C=20`) — intentionally over burst, so some 429s:

```json
{
  "N": 500,
  "ok": 370,
  "fail": 130,
  "C": 20,
  "sec": 1.93,
  "rps": 259.6,
  "p50": 68.7,
  "p95": 131.1,
  "p99": 335.5
}
```

**Hard push** (`N=2000`, `C=20`) — rate limiter doing its job:

```json
{
  "N": 2000,
  "ok": 494,
  "fail": 1506,
  "C": 20,
  "sec": 2.99,
  "rps": 669.6,
  "p50": 24.8,
  "p95": 58.9,
  "p99": 81.9
}
```

Takeaway: create path is fine in the low tens of ms when Redis/Mongo are healthy. Push past the tenant bucket and you get 429s instead of melting Mongo. Failures in the last two runs are almost all rate limits, not 5xx.

Reproduce:

```bash
N=180 C=10 npm run load
N=500 C=20 npm run load
```

---

## 3. explain() output and supporting index

Supporting index (`src/db.ts`):

```js
{ tenantId: 1, siteId: 1, status: 1, createdAt: -1, _id: -1 }  // name: list_by_site_status
```

Equality fields first, then the sort/range on `createdAt` / `_id` (ESR). Also:

- `list_by_tenant` — `{ tenantId: 1, createdAt: -1, _id: -1 }` for tenant-wide lists
- `uniq_idem` — unique `{ tenantId: 1, idempotencyKey: 1 }` (partial, string keys only); Redis caches the response, unique index is the race backstop

`npm run explain` (list: tenant + site_1 + checked_in + createdAt ≥ start of today):

```json
{
  "indexHint": "list_by_site_status",
  "ms": 21,
  "docsExamined": 0,
  "keysExamined": 0,
  "nReturned": 0,
  "winningPlan": {
    "stage": "LIMIT",
    "limitAmount": 50,
    "inputStage": {
      "stage": "FETCH",
      "inputStage": {
        "stage": "IXSCAN",
        "keyPattern": {
          "tenantId": 1,
          "siteId": 1,
          "status": 1,
          "createdAt": -1,
          "_id": -1
        },
        "indexName": "list_by_site_status"
      }
    }
  }
}
```

Empty today-window is fine — seed ages out of “today”; planner still picks `list_by_site_status` and does not COLLSCAN.

Same shape without the today filter (so we actually return rows from the 500k seed):

```json
{
  "ms": 12,
  "docsExamined": 50,
  "keysExamined": 50,
  "nReturned": 50,
  "indexName": "list_by_site_status"
}
```

`docsExamined === nReturned` — no wasted fetch. That is what I wanted from the compound index.

---

## 4. Trade-offs I made, and why

- **Redis token bucket for rate limits, shared across instances.** In-process counters break as soon as you run more than one API. Trade-off: Redis is on the hot path; if Redis is down, middleware **fails open** so check-ins still work. Fine for a take-home; I would not ship fail-open to production without a clearer degraded mode.
- **Idempotency = Redis cache + unique Mongo index.** Cache makes replays cheap; unique index wins when two requests race before the cache write. Trade-off: two stores to reason about, and TTL on the cache (24h) means very late retries fall through to the unique index / existing row lookup.
- **Webhooks are async via a Redis list + worker, fire-and-forget enqueue.** Create latency should not wait on the customer’s HTTP endpoint. Trade-off: enqueue can fail after insert (logged); at-least-once delivery with retries, not exactly-once.
- **Cursor pagination (`createdAt` + `_id`), not offset.** Stable under inserts; offset gets expensive and drifts. Trade-off: clients cannot jump to “page 50”.
- **API key in Mongo, looked up every request.** Simple and enough for the assessment. Trade-off: extra read per request; at higher QPS I would cache tenant config in Redis with a short TTL.
- **Single Mongo database, tenant isolation by `tenantId` in queries + indexes.** Separate DBs per tenant would be an ops nightmare here. Trade-off: noisy neighbor is possible; rate limit is the first brake.
- **Few endpoints done carefully (create / list / checkout) instead of a wider API surface.** Matching what this assessment actually weights.

### Weaknesses I am not proud of (but am naming)

These are real gaps in *this* submission, not theoretical future work:

- **No automated cross-tenant test.** Every checkin query predicates on `tenantId` from the API key (create, list, checkout, idempotent replay). I believe isolation holds, but I never checked in a test that tenant B requesting tenant A’s `_id` returns 404. That is a hole in proof, not in the query shape.
- **Idempotency is opt-in.** No `Idempotency-Key` → duplicates are allowed. Fine for some clients; bad if a flaky mobile retries without the header. I did not force the header on create.
- **Webhook path can lose the “notify” after a successful insert** if `LPUSH` fails — check-in is durable, side effect is not. At-least-once the other way too (retries). No outbox table.
- **Rate limiter fails open when Redis is broken.** Availability over protection. A thundering herd could hit Mongo unprotected.
- **Load numbers are one laptop, one API process.** p95 under budget looks good; it is not a multi-AZ soak. The `N=500` / `N=2000` runs are mostly 429s by design — useful for limiter behaviour, not for max Mongo write throughput.
- **`npm run explain` against “today” returned 0 rows** on a seed that ages out of the day window. Planner still chose `list_by_site_status` (good), but the impressive `docsExamined === nReturned` proof needed a wider filter. Skewed seed (≈40% on one tenant) is representative; my default explain script was a bit lazy about the time window.
- **Hot tenant write skew is indexed for reads, not solved for writes.** One primary still takes that tenant’s creates. I did not shard.
- **Almost no automated test suite.** Correctness arguments are code inspection + manual/load scripts. That would not be enough for a production merge.

---

## 5. What breaks at 100× this volume, and what I would change first

Seed today is ~500k rows / one API. 100× ≈ **50M checkins**, and write traffic in the same ballpark relative to what I tested.

What breaks first:

1. **Single Mongo primary** — write amplification from indexes + hot tenant (seed already puts ~40% on tenant 0). Secondary reads help lists; they do not help creates.
2. **Auth lookup every request** — becomes measurable CPU + Mongo chatter.
3. **Redis list webhook queue** — one worker, one list; backlog grows if destinations are slow.
4. **Working set / index RAM** — `list_by_site_status` and idempotency index stop fitting comfortably; p95 list latency climbs.
5. **Rate-limit Lua per request** — fine now; at much higher QPS you want coarser accounting or edge limiting.

What I would change **first**: put a **cache in front of tenant auth** (Redis, 30–60s TTL), then **shard or split write load** for the heaviest tenants (or at least isolate the top tenants onto their own Mongo). Webhook workers scale horizontally next (multiple consumers on the same queue, or move to SQS/NATS if we outgrow Redis lists). I would not jump straight to Kafka for this workload.

---

## 6. What I deliberately did not build (and why that was right for the time budget)

- **HMAC-signed webhooks / delivery dashboard** — retries + failure collection are enough to prove the pattern.
- **Full OpenAPI / client SDKs** — nice, not required to show correctness under load.
- **Kafka / CDC / separate analytics store** — overkill for check-in create + site list.
- **Per-tenant databases or Mongo sharding config** — premature at 500k; index design matters more here.
- **JWT / OAuth / admin UI** — API keys match the multi-tenant check-in case.
- **Strict fail-closed when Redis dies** — would have forced more failover design than the clock allowed.
- **k6/Locust harness** — a small Node load script was enough to get p50/p95 and exercise 429s.
- **Multi-region / automatic failover** — out of scope; compose `--profile multi` only shows horizontal API instances sharing Redis state.

Correctness path (idempotent create, indexed list, async webhooks, basic limits, explain proof) mattered more than more endpoints. I would rather defend three solid routes than ship a half-finished admin API.

---

## 7. What I used AI for

- Drafting and tightening this `SUBMISSION.md` and polishing Section B/C wording.
- Sanity-checking how to present `explain()` and the month-1 cut clearly.

I did **not** use AI to invent load numbers — the JSON above is from `npm run load` / `npm run explain` against a seeded local DB. Using AI is not weighted in this assessment; honesty about what is weak is.
