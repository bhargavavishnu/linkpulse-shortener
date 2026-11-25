import express from "express";
import cors from "cors";
import { query } from "./db.js";
import { redis } from "./redis.js";
import { createTokenBucketLimiter } from "./middleware/rateLimiter.js";
import { linksRouter } from "./routes/links.js";
import { logClickEvent } from "./services/clickPipeline.js";

export function createApp({
  rateLimitCapacity,
  rateLimitRefillPerSec,
  trackPendingClick = null,
} = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "256kb" }));

  const limiter = createTokenBucketLimiter({
    capacity: rateLimitCapacity,
    refillPerSec: rateLimitRefillPerSec,
  });

  app.get("/api/health", async (_req, res) => {
    try {
      await query("SELECT 1");
      const pong = await redis.ping();
      return res.json({ status: "ok", postgres: "up", redis: pong });
    } catch (err) {
      return res.status(503).json({ status: "degraded", error: err.message });
    }
  });

  app.use("/api/links", limiter, linksRouter);

  // Hot-link redirect endpoint with Redis lookup first + async PostgreSQL telemetry
  app.get("/:code", limiter, async (req, res, next) => {
    try {
      const { code } = req.params;
      if (code === "favicon.ico") {
        return res.status(404).end();
      }

      let target = null;
      let cacheStatus = "MISS";

      try {
        const cached = await redis.get(`hot:link:${code}`);
        if (cached) {
          target = JSON.parse(cached);
          cacheStatus = "HIT";
        }
      } catch {
        // Continue cleanly to DB lookup
      }

      if (!target) {
        const found = await query(
          "SELECT id, original_url FROM short_links WHERE short_code = $1",
          [code]
        );
        if (found.rowCount === 0) {
          return res.status(404).json({ error: "Short URL not found" });
        }
        target = {
          id: Number(found.rows[0].id),
          originalUrl: found.rows[0].original_url,
        };
      }

      const clickPromise = logClickEvent({
        shortLinkId: target.id,
        referer: req.headers.referer || req.headers.referrer || "",
        userAgent: req.headers["user-agent"] || "",
        ip: req.ip || req.socket?.remoteAddress || "",
      }).catch(() => {});

      if (typeof trackPendingClick === "function") {
        trackPendingClick(clickPromise);
      }

      res.set("X-Cache", cacheStatus);
      return res.redirect(302, target.originalUrl);
    } catch (err) {
      return next(err);
    }
  });

  app.use((err, _req, res, _next) => {
    return res.status(err.status || 500).json({
      error: err.message || "Internal server error",
    });
  });

  return app;
}
