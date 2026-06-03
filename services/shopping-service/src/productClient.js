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

// Atomically decrement stock for purchased items. Throws on failure; the thrown
// Error carries `.status` so the caller can distinguish 409 (insufficient stock).
async function decrementStock(items) {
  if (!items.length) return { updated: [] };
  const res = await fetch(`${BASE}/products/decrement-stock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.message || `product-service returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Best-effort compensation: restore stock after a failed order. Never throws.
async function restock(items) {
  if (!items.length) return;
  try {
    await fetch(`${BASE}/products/restock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
  } catch (_) {
    /* swallow — compensation is best-effort */
  }
}

module.exports = { getProductsByIds, decrementStock, restock };
