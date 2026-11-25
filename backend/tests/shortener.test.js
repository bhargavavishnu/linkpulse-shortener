import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { encodeBase62, decodeBase62 } from "../src/utils/base62.js";
import { createApp } from "../src/app.js";
import { pool, query } from "../src/db.js";
import { redis } from "../src/redis.js";

const pendingClicks = [];
let app;
const createdCodes = [];

before(() => {
  app = createApp({
    rateLimitCapacity: 50,
    rateLimitRefillPerSec: 1,
    trackPendingClick: (p) => pendingClicks.push(p),
  });
});

after(async () => {
  await Promise.allSettled(pendingClicks);
  await redis.del("rl:bucket:test-client", "rl:bucket:burst-client");
  for (const code of createdCodes) {
    await redis.del(`hot:link:${code}`);
  }
  if (createdCodes.length > 0) {
    await query("DELETE FROM short_links WHERE short_code = ANY($1::text[])", [
      createdCodes,
    ]);
  }
  await redis.quit();
  await pool.end();
});

test("1. Custom Base62 encoder/decoder roundtrip across ID magnitudes", () => {
  for (const n of [1, 2, 61, 62, 3844, 150000, 987654321]) {
    const encoded = encodeBase62(n);
    assert.equal(typeof encoded, "string");
    assert.ok(encoded.length >= 5);
    assert.equal(decodeBase62(encoded), n);
  }
  assert.throws(() => decodeBase62("!invalid!"));
});

test("2. Link shortening, redirects, top-20% Redis cache warming, and PG click analytics views", async () => {
  const health = await request(app).get("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.postgres, "up");
  assert.equal(health.body.redis, "PONG");

  // Auto Base62 link
  const created = await request(app)
    .post("/api/links")
    .set("x-rate-limit-key", "test-client")
    .send({ url: "https://postgresql.org/docs/17" });
  assert.equal(created.status, 201);
  const autoCode = created.body.link.short_code;
  createdCodes.push(autoCode);

  // Custom alias + duplicate rejection
  const customAlias = `gh_${Date.now()}`;
  const custom = await request(app)
    .post("/api/links")
    .set("x-rate-limit-key", "test-client")
    .send({ url: "https://github.com", customCode: customAlias });
  assert.equal(custom.status, 201);
  createdCodes.push(customAlias);

  const dup = await request(app)
    .post("/api/links")
    .set("x-rate-limit-key", "test-client")
    .send({ url: "https://github.com", customCode: customAlias });
  assert.equal(dup.status, 409);

  // Cold redirect -> X-Cache: MISS
  const rMiss = await request(app)
    .get(`/${autoCode}`)
    .set("x-rate-limit-key", "test-client")
    .set("user-agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)")
    .set("referer", "https://news.ycombinator.com/item?id=1");
  assert.equal(rMiss.status, 302);
  assert.equal(rMiss.headers.location, "https://postgresql.org/docs/17");
  assert.equal(rMiss.headers["x-cache"], "MISS");

  await Promise.allSettled(pendingClicks.splice(0));

  // Promote top 20% links into Redis hot cache
  const warm = await request(app)
    .post("/api/links/cache/warm-top")
    .set("x-rate-limit-key", "test-client");
  assert.equal(warm.status, 200);
  assert.ok(warm.body.cachedCount >= 1);

  // Hottest link redirect -> X-Cache: HIT
  const rHit = await request(app)
    .get(`/${autoCode}`)
    .set("x-rate-limit-key", "test-client")
    .set("user-agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X)")
    .set("referer", "https://github.com/features");
  assert.equal(rHit.status, 302);
  assert.equal(rHit.headers["x-cache"], "HIT");

  await Promise.allSettled(pendingClicks.splice(0));

  const analytics = await request(app)
    .get(`/api/links/${autoCode}/analytics`)
    .set("x-rate-limit-key", "test-client");
  assert.equal(analytics.status, 200);
  assert.equal(analytics.body.link.click_count, 2);
  assert.ok(analytics.body.daily.length >= 1);
  assert.ok(analytics.body.weekly.length >= 1);
  assert.ok(analytics.body.devices.some((d) => d.device_type === "mobile"));
  assert.ok(analytics.body.devices.some((d) => d.device_type === "desktop"));

  const listed = await request(app)
    .get("/api/links")
    .set("x-rate-limit-key", "test-client");
  assert.equal(listed.status, 200);
  assert.ok(listed.body.links.some((l) => l.short_code === autoCode));
});

test("3. Token-bucket rate limiter returns 429 when bucket is exhausted", async () => {
  const burstApp = createApp({
    rateLimitCapacity: 3,
    rateLimitRefillPerSec: 0.01,
  });

  for (let i = 0; i < 3; i += 1) {
    const okRes = await request(burstApp)
      .get("/api/links")
      .set("x-rate-limit-key", "burst-client");
    assert.equal(okRes.status, 200);
  }

  const blocked = await request(burstApp)
    .get("/api/links")
    .set("x-rate-limit-key", "burst-client");
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers["retry-after"]);
});
