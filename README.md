# check-in api (typescript)

Multi-tenant visitor check-in API. Express + MongoDB + Redis.

## Local run

1. Start MongoDB and Redis on localhost.
2. Copy `.env.example` → `.env` (already points at `127.0.0.1`).
3. Build and start:

```powershell
cd checkin-api
npm install
npm run build
npm start
```

Other terminals (from `checkin-api`):

```powershell
npm run worker
npm run seed
```

Dev (no build):

```powershell
npm run dev
npm run dev:worker
```

## Docker

```powershell
cd checkin-api
docker compose up --build -d
docker compose exec api node dist/scripts/seed.js
```

API: `http://localhost:3000`  
Demo key after seed: `nb_live_001_demo`

```powershell
curl http://localhost:3000/ready
curl -X POST http://localhost:3000/v1/checkins -H "content-type: application/json" -H "x-api-key: nb_live_001_demo" -H "idempotency-key: t1" -d "{\"siteId\":\"site_1\",\"visitorName\":\"test\"}"
```

`/health` = process up. `/ready` = mongo + redis ok.
