// Read product data for enrichment from the local, event-maintained
// ProductProjection (CQRS read model) instead of calling product-service on
// every request. Any ids not yet present in the projection fall back to a
// best-effort HTTP fetch, so behaviour degrades gracefully before the
// projection has warmed up (e.g. for products created by the seed script,
// which bypasses the event path).
const prisma = require("./prisma");
const { getProductsByIds } = require("./productClient");

async function getProductViews(ids) {
  if (!ids.length) return [];

  const local = await prisma.productProjection.findMany({ where: { id: { in: ids } } });
  const have = new Set(local.map((p) => p.id));
  const missing = ids.filter((id) => !have.has(id));

  let remote = [];
  if (missing.length) {
    try {
      remote = await getProductsByIds(missing);
    } catch (_) {
      /* best-effort: callers tolerate missing entries */
    }
  }

  // Normalise both sources to the same shape the callers already expect.
  return [...local, ...remote].map((p) => ({
    id: p.id,
    name: p.name,
    price: p.price,
    stock: p.stock,
    active: p.active,
  }));
}

module.exports = { getProductViews };
