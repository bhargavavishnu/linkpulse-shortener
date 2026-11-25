import express from "express";
import { config } from "../config.js";
import { query } from "../db.js";
import { redis } from "../redis.js";
import { encodeBase62 } from "../utils/base62.js";
import { refreshHotLinkCache } from "../services/clickPipeline.js";

export const linksRouter = express.Router();

const CUSTOM_CODE_RE = /^[A-Za-z0-9_-]{3,24}$/;
const RESERVED_CODES = new Set(["api", "health", "favicon.ico"]);

function isValidHttpUrl(input) {
  try {
    const parsed = new URL(input);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// POST /api/links
linksRouter.post("/", async (req, res, next) => {
  try {
    const originalUrl = String(req.body?.url || req.body?.originalUrl || "").trim();
    const customCode = req.body?.customCode
      ? String(req.body.customCode).trim()
      : null;

    if (!isValidHttpUrl(originalUrl)) {
      return res
        .status(400)
        .json({ error: "A valid http:// or https:// url is required" });
    }

    if (customCode) {
      if (!CUSTOM_CODE_RE.test(customCode) || RESERVED_CODES.has(customCode)) {
        return res.status(400).json({
          error: "customCode must be 3-24 alphanumeric, '-' or '_' characters",
        });
      }
      try {
        const inserted = await query(
          `INSERT INTO short_links (short_code, original_url, custom_alias)
           VALUES ($1, $2, TRUE)
           RETURNING *`,
          [customCode, originalUrl]
        );
        const link = inserted.rows[0];
        return res.status(201).json({
          link: { ...link, short_url: `${config.baseUrl}/${link.short_code}` },
        });
      } catch (err) {
        if (err.code === "23505") {
          return res.status(409).json({ error: "customCode already exists" });
        }
        throw err;
      }
    }

    const seqRes = await query(
      "SELECT nextval(pg_get_serial_sequence('short_links', 'id')) AS id"
    );
    const nextId = Number(seqRes.rows[0].id);
    const shortCode = encodeBase62(nextId);

    const inserted = await query(
      `INSERT INTO short_links (id, short_code, original_url, custom_alias)
       VALUES ($1, $2, $3, FALSE)
       RETURNING *`,
      [nextId, shortCode, originalUrl]
    );
    const link = inserted.rows[0];
    return res.status(201).json({
      link: { ...link, short_url: `${config.baseUrl}/${link.short_code}` },
    });
  } catch (err) {
    return next(err);
  }
});

// GET /api/links
linksRouter.get("/", async (_req, res, next) => {
  try {
    const result = await query(
      `SELECT id, short_code, original_url, custom_alias, click_count, is_hot, created_at
       FROM short_links
       ORDER BY click_count DESC, id DESC
       LIMIT 100`
    );
    const links = result.rows.map((row) => ({
      ...row,
      click_count: Number(row.click_count),
      short_url: `${config.baseUrl}/${row.short_code}`,
    }));
    return res.json({ links });
  } catch (err) {
    return next(err);
  }
});

// POST /api/links/cache/warm-top
linksRouter.post("/cache/warm-top", async (_req, res, next) => {
  try {
    const summary = await refreshHotLinkCache(0.2);
    return res.json(summary);
  } catch (err) {
    return next(err);
  }
});

// GET /api/links/:code/analytics
linksRouter.get("/:code/analytics", async (req, res, next) => {
  try {
    const code = req.params.code;
    const linkRes = await query(
      "SELECT * FROM short_links WHERE short_code = $1",
      [code]
    );
    if (linkRes.rowCount === 0) {
      return res.status(404).json({ error: "Short link not found" });
    }
    const link = linkRes.rows[0];

    const [dailyRes, weeklyRes, refRes, devRes] = await Promise.all([
      query(
        `SELECT day, clicks, mobile_clicks, desktop_clicks, tablet_clicks
         FROM daily_click_stats
         WHERE short_link_id = $1
         ORDER BY day DESC
         LIMIT 30`,
        [link.id]
      ),
      query(
        `SELECT week_start, clicks, unique_referrers
         FROM weekly_click_stats
         WHERE short_link_id = $1
         ORDER BY week_start DESC
         LIMIT 12`,
        [link.id]
      ),
      query(
        `SELECT referrer, COUNT(*)::int AS clicks
         FROM click_events
         WHERE short_link_id = $1
         GROUP BY referrer
         ORDER BY clicks DESC
         LIMIT 10`,
        [link.id]
      ),
      query(
        `SELECT device_type, COUNT(*)::int AS clicks
         FROM click_events
         WHERE short_link_id = $1
         GROUP BY device_type
         ORDER BY clicks DESC`,
        [link.id]
      ),
    ]);

    return res.json({
      link: {
        ...link,
        click_count: Number(link.click_count),
        short_url: `${config.baseUrl}/${link.short_code}`,
      },
      daily: dailyRes.rows,
      weekly: weeklyRes.rows,
      referrers: refRes.rows,
      devices: devRes.rows,
    });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/links/:code
linksRouter.delete("/:code", async (req, res, next) => {
  try {
    const deleted = await query(
      "DELETE FROM short_links WHERE short_code = $1 RETURNING id",
      [req.params.code]
    );
    if (deleted.rowCount === 0) {
      return res.status(404).json({ error: "Short link not found" });
    }
    await redis.del(`hot:link:${req.params.code}`);
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
});
