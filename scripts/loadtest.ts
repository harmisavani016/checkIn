// quick load pass — no k6 required
import http from 'http';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const API_KEY = process.env.API_KEY || 'nb_live_001_demo';
const C = Number(process.env.C || 20);
const N = Number(process.env.N || 500);

const times: number[] = [];
let ok = 0;
let fail = 0;

function req(i: number): Promise<void> {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const body = JSON.stringify({
      siteId: 'site_' + ((i % 5) + 1),
      visitorName: 'L' + i,
    });
    const u = new URL('/v1/checkins', BASE);
    const r = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-api-key': API_KEY,
          'idempotency-key': 'lt-' + Date.now() + '-' + i,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          times.push(Number(process.hrtime.bigint() - t0) / 1e6);
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) ok++;
          else fail++;
          resolve();
        });
      }
    );
    r.on('error', () => {
      fail++;
      resolve();
    });
    r.end(body);
  });
}

function p(arr: number[], pct: number) {
  const s = arr.slice().sort((a, b) => a - b);
  if (!s.length) return 0;
  return s[Math.min(s.length - 1, Math.floor((pct / 100) * s.length))];
}

(async () => {
  const start = Date.now();
  let i = 0;
  async function worker() {
    while (i < N) {
      const n = i++;
      await req(n);
    }
  }
  await Promise.all(Array.from({ length: C }, () => worker()));
  const sec = (Date.now() - start) / 1000;
  console.log(
    JSON.stringify(
      {
        N,
        ok,
        fail,
        C,
        sec: +sec.toFixed(2),
        rps: +(N / sec).toFixed(1),
        p50: +p(times, 50).toFixed(1),
        p95: +p(times, 95).toFixed(1),
        p99: +p(times, 99).toFixed(1),
      },
      null,
      2
    )
  );
})();
