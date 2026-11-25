import Redis from "ioredis";
import { config } from "./config.js";

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 2,
  enableReadyCheck: true,
});

redis.on("error", (err) => {
  if (process.env.NODE_ENV !== "test") {
    console.error("[redis] connection error:", err.message);
  }
});
