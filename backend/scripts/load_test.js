import http from "node:http";
import { performance } from "node:perf_hooks";
import { createApp } from "../src/app.js";
import { pool, query } from "../src/db.js";
import { redis } from "../src/redis.js";
import { refreshHotLinkCache } from "../src/services/clickPipeline.js";
import { encodeBase62 } from "../src/utils/base62.js";

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  const pendingClicks = [];
  const app = createApp({
    rateLimitCapacity: 1000,
    rateLimitRefillPerSec: 50,
    trackPendingClick: (p) => pendingClicks.push(p),
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const createdIds = [];
  const createdCodes = [];

  try {
    // Seed 10 links and make top 20% (2 links) receive high traffic & warm Redis hot cache
    for (let i = 0; i < 10; i += 1) {
      const seq = await query(
        "SELECT nextval(pg_get_serial_sequence('short_links', 'id')) AS id"
      );
      const id = Number(seq.rows[0].id);
      const code = encodeBase62(id);
      const clicks = i < 2 ? 500 - i * 50 : i;
      await query(
        `INSERT INTO short_links (id, short_code, original_url, click_count)
         VALUES ($1, $2, $3, $4)`,
        [id, code, `https://example.org/docs/page-${i}`, clicks]
      );
      createdIds.push(id);
      createdCodes.push(code);
    }

    const warmSummary = await refreshHotLinkCache(0.2);
    const hotCode = createdCodes[0];
    const coldCode = createdCodes[9];

    // Warm up TCP/Express
    await fetch(`${baseUrl}/${hotCode}`, { redirect: "manual" });

    // Measure 600 redirect requests against rate limiter + hot cache (500+ req/min throughput verification)
    const hotLatencies = [];
    const coldLatencies = [];
    const tLoadStart = performance.now();

    // Run batches of 15 concurrent requests for 600 total requests (480 hot 80%, 120 cold 20%)
    const totalRequests = 600;
    const concurrency = 15;
    let completed = 0;
    let rateLimited = 0;

    for (let batchStart = 0; batchStart < totalRequests; batchStart += concurrency) {
      const batch = [];
      for (let j = 0; j < concurrency && batchStart + j < totalRequests; j += 1) {
        const idx = batchStart + j;
        const isHot = idx % 5 !== 0; // 80% traffic hits top-20% hot links
        const targetCode = isHot ? hotCode : coldCode;
        batch.push(
          (async () => {
            const t0 = performance.now();
            const res = await fetch(`${baseUrl}/${targetCode}`, {
              redirect: "manual",
              headers: {
                "x-rate-limit-key": "load-test-runner",
                "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)",
                referer: "https://github.com/trending",
              },
            });
            const dt = performance.now() - t0;
            if (res.status === 302) {
              completed += 1;
              if (isHot) hotLatencies.push(dt);
              else coldLatencies.push(dt);
            } else if (res.status === 429) {
              rateLimited += 1;
            }
          })()
        );
      }
      await Promise.all(batch);
    }

    const totalElapsedSec = (performance.now() - tLoadStart) / 1000.0;
    const reqPerMinute = (completed / totalElapsedSec) * 60.0;

    await Promise.allSettled(pendingClicks);

    hotLatencies.sort((a, b) => a - b);
    coldLatencies.sort((a, b) => a - b);
    const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;

    console.log(
      JSON.stringify(
        {
          warmTop20PctSummary: warmSummary,
          totalRequestsAttempted: totalRequests,
          succeededRedirects: completed,
          rateLimited429: rateLimited,
          elapsedSeconds: Number(totalElapsedSec.toFixed(3)),
          achievedRequestsPerMinute: Math.round(reqPerMinute),
          hotLinkRedirectMs: {
            samples: hotLatencies.length,
            mean: Number(mean(hotLatencies).toFixed(3)),
            p50: Number(percentile(hotLatencies, 50).toFixed(3)),
            p95: Number(percentile(hotLatencies, 95).toFixed(3)),
          },
          coldLinkRedirectMs: {
            samples: coldLatencies.length,
            mean: Number(mean(coldLatencies).toFixed(3)),
            p50: Number(percentile(coldLatencies, 50).toFixed(3)),
            p95: Number(percentile(coldLatencies, 95).toFixed(3)),
          },
        },
        null,
        2
      )
    );
  } finally {
    await redis.del("rl:bucket:load-test-runner");
    for (const c of createdCodes) {
      await redis.del(`hot:link:${c}`);
    }
    if (createdIds.length > 0) {
      await query("DELETE FROM short_links WHERE id = ANY($1::bigint[])", [
        createdIds,
      ]);
    }
    await new Promise((resolve) => server.close(resolve));
    await redis.quit();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
