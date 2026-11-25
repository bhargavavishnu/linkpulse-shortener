import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: Number(process.env.PORT || 4100),
  baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 4100}`,
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgresql://bhargava@localhost:5432/linkpulse_db",
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379/3",
  rateLimitCapacity: Number(process.env.RATE_LIMIT_CAPACITY || 600),
  rateLimitRefillPerSec: Number(process.env.RATE_LIMIT_REFILL_PER_SEC || 10),
  hotCacheTtlSeconds: Number(process.env.HOT_CACHE_TTL_SECONDS || 300),
};
