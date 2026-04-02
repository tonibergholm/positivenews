import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});

redis.on("error", (err) => {
  // Log but don't crash — classifier falls back to DB on Redis failure
  console.error("[redis] Connection error:", err.message);
});

export default redis;
