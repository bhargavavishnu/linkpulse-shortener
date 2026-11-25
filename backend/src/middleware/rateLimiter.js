import { config } from "../config.js";
import { redis } from "../redis.js";

const LUA_TOKEN_BUCKET = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_sec = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])

local data = redis.call("HMGET", key, "tokens", "ts")
local tokens = tonumber(data[1])
local ts = tonumber(data[2])

if tokens == nil or ts == nil then
  tokens = capacity
  ts = now_ms
else
  local elapsed_sec = math.max(0, (now_ms - ts) / 1000.0)
  tokens = math.min(capacity, tokens + elapsed_sec * refill_per_sec)
  ts = now_ms
end

local allowed = 0
local retry_after = 0
if tokens >= requested then
  tokens = tokens - requested
  allowed = 1
else
  local deficit = requested - tokens
  retry_after = math.ceil(deficit / math.max(refill_per_sec, 0.001))
end

redis.call("HSET", key, "tokens", tokens, "ts", ts)
redis.call("EXPIRE", key, math.ceil(capacity / math.max(refill_per_sec, 0.001)) + 60)
return { allowed, math.floor(tokens), retry_after }
`;

/**
 * Create an Express token-bucket rate limiter backed by Redis Lua atomicity.
 */
export function createTokenBucketLimiter({
  capacity = config.rateLimitCapacity,
  refillPerSec = config.rateLimitRefillPerSec,
  keyPrefix = "rl:bucket",
} = {}) {
  return async (req, res, next) => {
    const clientKey =
      req.headers["x-rate-limit-key"] ||
      req.ip ||
      req.socket?.remoteAddress ||
      "anonymous";
    const redisKey = `${keyPrefix}:${clientKey}`;

    try {
      const [allowed, remaining, retryAfter] = await redis.eval(
        LUA_TOKEN_BUCKET,
        1,
        redisKey,
        capacity,
        refillPerSec,
        Date.now(),
        1
      );

      res.set("X-RateLimit-Limit", String(capacity));
      res.set("X-RateLimit-Remaining", String(Math.max(0, Number(remaining))));

      if (Number(allowed) !== 1) {
        res.set("Retry-After", String(Math.max(1, Number(retryAfter))));
        return res.status(429).json({
          error: "Rate limit exceeded (token bucket empty)",
          retryAfterSeconds: Math.max(1, Number(retryAfter)),
        });
      }

      return next();
    } catch {
      // Fail open on unexpected Redis errors rather than taking down redirects.
      return next();
    }
  };
}
