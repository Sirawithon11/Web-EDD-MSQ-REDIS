// Thin client for talking to product-service over HTTP.
// Uses the global fetch available in Node 18+.
const BASE = process.env.PRODUCT_SERVICE_URL || "http://localhost:4002";

async function getProductsByIds(ids) {
  if (!ids.length) return [];
  const res = await fetch(`${BASE}/products/bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    throw new Error(`product-service returned ${res.status}`);
  }
  return res.json();
}

module.exports = { getProductsByIds };
