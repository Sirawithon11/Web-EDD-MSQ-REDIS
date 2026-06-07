// Redis cache (cache-aside) for product-service.
//
// GET /products is filtered + paginated, so each distinct query string is its
// own cache entry. To invalidate them ALL on any catalogue change we keep a
// generation counter (`products:list:ver`) and embed it in every key. Bumping
// the counter orphans every old key at once (they then expire by TTL) — no
// SCAN/KEYS sweep required.
//
// Degrades gracefully: if Redis is unreachable every op becomes a no-op, so the
// endpoint still serves straight from Postgres.
const Redis = require("ioredis");
const crypto = require("crypto");

const URL = process.env.REDIS_URL || "redis://localhost:6380";
const PASSWORD = process.env.REDIS_PASSWORD || "root";
// Short by default: product lists show stock, which the TTL keeps reasonably
// fresh between catalogue edits.
const TTL = Number(process.env.PRODUCT_CACHE_TTL_SECONDS || 30);

const redis = new Redis(URL, {
  password: PASSWORD,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});

let warned = false;
redis.on("error", (err) => {
  if (!warned) {
    console.error("[cache] redis unavailable, serving from DB:", err.message);
    warned = true;
  }
});
redis.on("ready", () => {
  warned = false;
  console.log("[cache] redis connected");
});

const LIST_VER_KEY = "products:list:ver";

async function currentVersion() {
  try {
    // Missing key => generation 0; the first invalidation INCRs it to 1.
    return (await redis.get(LIST_VER_KEY)) || "0";
  } catch (_) {
    return "0";
  }
}

// Build a stable cache key for a set of (already-normalised) list params under
// the current generation.
async function listKey(params) {
  const ver = await currentVersion();
  const hash = crypto
    .createHash("sha1")
    .update(JSON.stringify(params))
    .digest("hex")
    .slice(0, 16);
  return `products:list:v${ver}:${hash}`;
}

async function getJSON(key) {
  try {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null; // treat any failure as a miss
  }
}

async function setJSON(key, value, ttl = TTL) {
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttl);
  } catch (_) {
    /* best-effort */
  }
}

// Invalidate every cached product list by advancing the generation counter.
async function invalidateProductLists() {
  try {
    await redis.incr(LIST_VER_KEY);
  } catch (_) {
    /* ignore */
  }
}

module.exports = { redis, listKey, getJSON, setJSON, invalidateProductLists, TTL };
