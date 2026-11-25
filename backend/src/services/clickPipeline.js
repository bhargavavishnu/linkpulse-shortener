import crypto from "node:crypto";
import { config } from "../config.js";
import { query } from "../db.js";
import { redis } from "../redis.js";

/**
 * Classify incoming HTTP client User-Agent into coarse analytics device segments.
 */
export function classifyDevice(userAgent = "") {
  const ua = userAgent.toLowerCase();
  if (/bot|crawler|spider|curl|wget|python-requests/.test(ua)) return "bot";
  if (/ipad|tablet|kindle/.test(ua)) return "tablet";
  if (/mobi|android|iphone|ipod/.test(ua)) return "mobile";
  return "desktop";
}

/**
 * Normalize HTTP Referer header into hostname or 'direct'.
 */
export function normalizeReferrer(referer = "") {
  if (!referer) return "direct";
  try {
    const u = new URL(referer);
    return u.hostname || "direct";
  } catch {
    return referer.slice(0, 120) || "direct";
  }
}

export function hashIp(ip = "") {
  return crypto
    .createHash("sha256")
    .update(String(ip || "unknown"))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Log click telemetry to PostgreSQL and update aggregate click counters.
 */
export async function logClickEvent({ shortLinkId, referer, userAgent, ip }) {
  const deviceType = classifyDevice(userAgent);
  const referrer = normalizeReferrer(referer);
  const ipHash = hashIp(ip);

  await query(
    `INSERT INTO click_events (short_link_id, referrer, device_type, user_agent, ip_hash)
     VALUES ($1, $2, $3, $4, $5)`,
    [shortLinkId, referrer, deviceType, (userAgent || "").slice(0, 500), ipHash]
  );

  await query(
    "UPDATE short_links SET click_count = click_count + 1 WHERE id = $1",
    [shortLinkId]
  );
}

/**
 * Cache top ~20% hottest links in Redis for sub-50ms hot-link redirects.
 */
export async function refreshHotLinkCache(topFraction = 0.2) {
  const totalRes = await query("SELECT COUNT(*)::int AS total FROM short_links");
  const total = Number(totalRes.rows[0]?.total || 0);
  if (total === 0) {
    return { total: 0, cachedCount: 0, hotCodes: [] };
  }

  const hotLimit = Math.max(1, Math.ceil(total * topFraction));
  const topRes = await query(
    `SELECT id, short_code, original_url, click_count
     FROM short_links
     ORDER BY click_count DESC, id ASC
     LIMIT $1`,
    [hotLimit]
  );

  const hotIds = topRes.rows.map((r) => r.id);
  await query("UPDATE short_links SET is_hot = (id = ANY($1::bigint[]))", [
    hotIds,
  ]);

  const pipeline = redis.pipeline();
  for (const row of topRes.rows) {
    pipeline.set(
      `hot:link:${row.short_code}`,
      JSON.stringify({ id: Number(row.id), originalUrl: row.original_url }),
      "EX",
      config.hotCacheTtlSeconds
    );
  }
  await pipeline.exec();

  return {
    total,
    cachedCount: topRes.rows.length,
    hotCodes: topRes.rows.map((r) => r.short_code),
  };
}
