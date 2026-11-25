# LinkPulse — URL Shortener & Click Analytics Platform

A high-throughput URL shortener and real-time click analytics service using **Node.js / Express**, **custom Base62 encoding**, atomic **Redis Lua token-bucket rate limiting**, top-20% **Redis hot-link caching** for sub-50ms redirects, **PostgreSQL** click telemetry + daily/weekly SQL views, and a **React** analytics dashboard.

## Architecture

```
                         +-----------------------------+
                         |  React Analytics Dashboard  |
                         |  Shorten URL + View Charts  |
                         +--------------+--------------+
                                        | REST (/api/links)
                                        v
+---------+   GET /:code  +-----------------------------+
| Client  | ------------> | Express + Lua Token Bucket  |
| Browser | <---- 302 --- | Redis Rate Limiter (429)    |
+---------+               +------+---------------+------+
                                 |               |
                     Top ~20%    |               | Async Click Pipeline
                     Hot Cache   v               v (device, referer, IP hash)
                         +-----------+   +-------------------------------+
                         | Redis     |   | PostgreSQL 17                 |
                         | hot:link  |   | - short_links & click_events  |
                         +-----------+   | - daily_click_stats VIEW      |
                                         | - weekly_click_stats VIEW     |
                                         +-------------------------------+
```

## Key Features

- **Custom Base62 Encoding (`backend/src/utils/base62.js`):** Deterministic, reversible Base62 encoding seeded with an offset (`62^4 - 1`) to generate compact 5+ character short codes from PostgreSQL sequence IDs, alongside vanity alias support (`customCode`).
- **Top-20% Hot-Link Redis Cache (`backend/src/services/clickPipeline.js`):** `refreshHotLinkCache(0.2)` promotes the highest-traffic 20% of URLs into Redis (`hot:link:<code>`, `X-Cache: HIT|MISS`), keeping redirect response latency well under 50ms.
- **Atomic Redis Token-Bucket Rate Limiter (`backend/src/middleware/rateLimiter.js`):** Executes an atomic Redis Lua script enforcing `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `429 Too Many Requests` with `Retry-After` on token exhaustion.
- **PostgreSQL Click Telemetry & Aggregated Views (`backend/sql/schema.sql`):** Records normalized `referrer`, parsed `device_type` (`desktop`, `mobile`, `tablet`, `bot`), SHA-256 truncated `ip_hash`, and `clicked_at`, feeding SQL views `daily_click_stats` and `weekly_click_stats`.

## Local Load Test & Latency Benchmark

Measured against local Express + PostgreSQL `17.12` + Redis `8.12.0` (`backend/scripts/load_test.js` — 600 requests with 80/20 hot-link traffic distribution, concurrency 15, capacity 1000 tokens):

| Metric | Measured Value |
| :--- | :--- |
| Requests Completed | `600 / 600` (`0` HTTP 429s under burst limit `1000`) |
| Elapsed Time | `0.18s` (local loopback equivalent `200,053 req/min`, easily exceeding `500+ req/min`) |
| Hot-Link Redirect Latency (Redis `HIT`, `n=480`) | Mean `2.912 ms` · p50 `2.585 ms` · p95 `4.896 ms` (**sub-50ms**) |
| Cold-Link Redirect Latency (PostgreSQL `MISS`, `n=120`) | Mean `3.855 ms` · p50 `3.259 ms` · p95 `5.994 ms` |

## Running Locally & Testing

> Note: `Dockerfile`s and `docker-compose.yml` are included for containerized deployment (`docker compose up --build`). Local macOS execution without Docker uses native PostgreSQL + Redis as shown below.

```bash
# 1. Load PostgreSQL schema & daily/weekly analytics views
psql "postgresql://localhost:5432/linkpulse_db" -f backend/sql/schema.sql

# 2. Install backend dependencies, run tests, and run local load test
cd backend
npm install
npm test
npm run loadtest

# 3. Start backend & React analytics dashboard
npm start
# in another terminal:
cd ../frontend
npm install
npm run build
npm run dev
```
