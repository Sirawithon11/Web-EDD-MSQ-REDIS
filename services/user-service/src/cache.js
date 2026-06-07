// Redis cache (cache-aside). A single shared client for the service.
//
// Degrades gracefully: if Redis is unreachable, every cache op becomes a no-op
// (get -> miss, set/del -> ignored) so the endpoint still works straight off
// Postgres. `enableOfflineQueue: false` makes commands fail fast instead of
// piling up while Redis is down.
const Redis = require("ioredis");

const URL = process.env.REDIS_URL || "redis://localhost:6380";
const PASSWORD = process.env.REDIS_PASSWORD || "root";
const TTL = Number(process.env.CACHE_TTL_SECONDS || 60);

const redis = new Redis(URL, {
  password: PASSWORD,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});

let warned = false;
redis.on("error", (err) => {
  if (!warned) {
    console.error("[cache] redis unavailable, serving from DB:", err.message);
    warned = true; // avoid log spam on every reconnect attempt
  }
});
redis.on("ready", () => {
  warned = false;
  console.log("[cache] redis connected");
});

// Cache keys. One key for the (param-less) admin user list.
const USERS_LIST_KEY = "users:list:all";

async function getJSON(key) {
  try {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null; // treat any failure as a cache miss
  }
}

async function setJSON(key, value, ttl = TTL) {
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttl);
  } catch (_) {
    /* ignore — caching is best-effort */
  }
}

async function del(...keys) {
  try {
    if (keys.length) await redis.del(...keys);
  } catch (_) {
    /* ignore */
  }
}

// Called whenever a domain event changes user data, so the next GET /users
// rebuilds the cache from Postgres. This is the event-driven invalidation hook.
async function invalidateUsersList() {
  await del(USERS_LIST_KEY);
}

module.exports = { redis, getJSON, setJSON, del, invalidateUsersList, USERS_LIST_KEY, TTL };
