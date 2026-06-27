#!/usr/bin/env node
/*
 * End-to-end API smoke test + latency report — exercises every endpoint that
 * touches the database, through the gateway, and times each call.
 * No dependencies (uses Node 18+ global fetch + performance).
 *
 * Prereqs: the stack is up (docker compose up -d) and seeded.
 *
 * Run:     node scripts/test-api.js
 *          API_URL=http://localhost:8080 node scripts/test-api.js   (override base)
 *          RUNS=5 node scripts/test-api.js                          (repeat & average)
 *
 * Exit code is non-zero if any check fails, so it's CI-friendly.
 */

const BASE = process.env.API_URL || "http://localhost:8080";
const RUNS = Math.max(1, Number(process.env.RUNS || 1));
const ADMIN = { email: "admin@shop.dev", password: "admin123" };

let pass = 0;
let fail = 0;
const failures = [];
const timings = new Map(); // "METHOD /path" -> [ms, ms, ...]

function check(name, ok, res) {
  const st = res?.status != null ? `\x1b[90m[${res.status}]\x1b[0m` : "";
  const ms = res?.ms != null ? `\x1b[90m${res.ms.toFixed(1)}ms\x1b[0m` : "";
  if (ok) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name} ${st} ${ms}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m ${st} ${ms}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

async function api(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const label = `${method} ${path.split("?")[0]}`;
  const start = performance.now();
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { status: 0, json: null, error: e.message, ms: performance.now() - start };
  }
  const text = await res.text();
  const ms = performance.now() - start;
  if (!timings.has(label)) timings.set(label, []);
  timings.get(label).push(ms);
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json, ms };
}

async function runSuite() {
  // ---------------------------------------------------------------- auth setup
  section("Auth / users");
  const login = await api("POST", "/api/users/login", { body: ADMIN });
  check("POST /api/users/login (admin)", login.status === 200 && !!login.json?.token, login);
  const adminToken = login.json?.token;
  if (!adminToken) {
    console.log("\n\x1b[31mCannot continue without an admin token (is the stack up & seeded?).\x1b[0m");
    process.exit(1);
  }

  const email = `apitest+${Date.now()}@shop.dev`;
  const reg = await api("POST", "/api/users/register", {
    body: { email, password: "password123", name: "API Test", phone: "+66800000001", address: "1 Test St" },
  });
  check("POST /api/users/register", reg.status === 201 && !!reg.json?.token, reg);
  const userToken = reg.json?.token;
  const userId = reg.json?.user?.id;

  const me = await api("GET", "/api/users/me", { token: userToken });
  check("GET /api/users/me", me.status === 200 && me.json?.email === email, me);

  const usersList = await api("GET", "/api/users", { token: adminToken });
  check("GET /api/users (admin)", usersList.status === 200 && Array.isArray(usersList.json), usersList);

  const userById = await api("GET", `/api/users/${userId}`, { token: adminToken });
  check("GET /api/users/:id (admin)", userById.status === 200 && userById.json?.id === userId, userById);

  // ---------------------------------------------------------- products (public)
  section("Products — public reads");
  const list = await api("GET", "/api/products?page=1&limit=5");
  check("GET /api/products (list)", list.status === 200 && Array.isArray(list.json?.data), list);
  const p0 = list.json?.data?.[0];

  const filtered = await api("GET", "/api/products?search=a&sort=price_asc&minPrice=1&maxPrice=10000&page=1&limit=5");
  check("GET /api/products (filtered)", filtered.status === 200 && Array.isArray(filtered.json?.data), filtered);

  const cats = await api("GET", "/api/products/categories");
  check("GET /api/products/categories", cats.status === 200 && Array.isArray(cats.json) && cats.json.length > 0, cats);
  const categoryId = cats.json?.[0]?.id ?? p0?.categoryId;

  if (p0) {
    const detail = await api("GET", `/api/products/${p0.id}`);
    check("GET /api/products/:id", detail.status === 200 && detail.json?.id === p0.id, detail);
    // NOTE: bulk / decrement-stock / restock are now INTERNAL gRPC-only methods
    // (shopping → product), not exposed at the gateway. They are exercised
    // end-to-end by the checkout flow below.
  } else {
    check("GET /api/products/:id", false, { status: 0 });
  }

  // ----------------------------------------------------------- products (admin)
  section("Products — admin CRUD + stock");
  const create = await api("POST", "/api/products", {
    token: adminToken,
    body: { name: "API Test Widget", description: "temp", price: 19.99, stock: 50, categoryId },
  });
  check("POST /api/products (create)", create.status === 201 && !!create.json?.id, create);
  const prodId = create.json?.id;

  if (prodId) {
    const upd = await api("PUT", `/api/products/${prodId}`, {
      token: adminToken,
      body: { name: "API Test Widget v2", price: 21.5, stock: 50, categoryId, active: true },
    });
    check("PUT /api/products/:id (update)", upd.status === 200 && upd.json?.name === "API Test Widget v2", upd);
  }

  const adminList = await api("GET", "/api/products/admin?limit=5", { token: adminToken });
  check("GET /api/products/admin", adminList.status === 200 && Array.isArray(adminList.json?.data), adminList);

  const pAudit = await api("GET", "/api/products/audit-logs?limit=5", { token: adminToken });
  check("GET /api/products/audit-logs", pAudit.status === 200 && Array.isArray(pAudit.json?.data), pAudit);

  // ----------------------------------------------------------------------- cart
  section("Cart");
  if (prodId) {
    const add = await api("POST", "/api/cart/items", { token: userToken, body: { productId: prodId, quantity: 2 } });
    check("POST /api/cart/items", add.status === 201, add);

    const getCart = await api("GET", "/api/cart", { token: userToken });
    check("GET /api/cart", getCart.status === 200 && Array.isArray(getCart.json?.items), getCart);
    const itemId = getCart.json?.items?.find((i) => i.productId === prodId)?.id;

    if (itemId) {
      const updItem = await api("PUT", `/api/cart/items/${itemId}`, { token: userToken, body: { quantity: 3 } });
      check("PUT /api/cart/items/:id", updItem.status === 200, updItem);
    }

    if (p0 && p0.id !== prodId) {
      await api("POST", "/api/cart/items", { token: userToken, body: { productId: p0.id, quantity: 1 } });
      const c2 = await api("GET", "/api/cart", { token: userToken });
      const delId = c2.json?.items?.find((i) => i.productId === p0.id)?.id;
      const delItem = await api("DELETE", `/api/cart/items/${delId}`, { token: userToken });
      check("DELETE /api/cart/items/:id", delItem.status === 200, delItem);
    }
  }

  // --------------------------------------------------------------------- orders
  section("Orders");
  const checkout = await api("POST", "/api/orders", { token: userToken });
  check("POST /api/orders (checkout)", checkout.status === 201 && !!checkout.json?.id, checkout);
  const orderId = checkout.json?.id;

  const myOrders = await api("GET", "/api/orders", { token: userToken });
  check("GET /api/orders", myOrders.status === 200 && Array.isArray(myOrders.json), myOrders);

  if (orderId) {
    const getOrder = await api("GET", `/api/orders/${orderId}`, { token: userToken });
    check("GET /api/orders/:id", getOrder.status === 200 && getOrder.json?.id === orderId, getOrder);

    const patch = await api("PATCH", `/api/orders/${orderId}/status`, { token: adminToken, body: { status: "PAID" } });
    check("PATCH /api/orders/:id/status (admin)", patch.status === 200 && patch.json?.status === "PAID", patch);
  }

  const allOrders = await api("GET", "/api/orders/all?limit=5", { token: adminToken });
  check("GET /api/orders/all (admin)", allOrders.status === 200 && Array.isArray(allOrders.json?.data), allOrders);

  const oAudit = await api("GET", "/api/orders/audit-logs?limit=5", { token: adminToken });
  check("GET /api/orders/audit-logs (admin)", oAudit.status === 200 && Array.isArray(oAudit.json?.data), oAudit);

  if (orderId) {
    const delOrder = await api("DELETE", `/api/orders/${orderId}`, { token: userToken });
    check("DELETE /api/orders/:id (own)", delOrder.status === 204, delOrder);
  }

  // ------------------------------------------------------- authorization checks
  section("Authorization (negative cases)");
  const noToken = await api("GET", "/api/orders");
  check("GET /api/orders without token → 401", noToken.status === 401, noToken);

  const userListAdmin = await api("GET", "/api/users", { token: userToken });
  check("GET /api/users as user → 403", userListAdmin.status === 403, userListAdmin);

  const userCreateProduct = await api("POST", "/api/products", { token: userToken, body: { name: "nope", price: 1, categoryId } });
  check("POST /api/products as user → 403", userCreateProduct.status === 403, userCreateProduct);

  const userAdminProducts = await api("GET", "/api/products/admin", { token: userToken });
  check("GET /api/products/admin as user → 403", userAdminProducts.status === 403, userAdminProducts);

  const userAllOrders = await api("GET", "/api/orders/all", { token: userToken });
  check("GET /api/orders/all as user → 403", userAllOrders.status === 403, userAllOrders);

  const badIdStatus = await api("PATCH", "/api/orders/notanumber/status", { token: adminToken, body: { status: "PAID" } });
  check("PATCH /api/orders/:id/status bad id → 400", badIdStatus.status === 400, badIdStatus);

  // ------------------------------------------------------ external time/weather
  // The sidebar clock + temperature widget calls Open-Meteo directly from the
  // browser (not through the gateway). Time it here too so its latency shows up
  // in the report alongside our own endpoints.
  section("External — time/weather API (Open-Meteo)");
  {
    const url =
      "https://api.open-meteo.com/v1/forecast?latitude=13.7563&longitude=100.5018&current=temperature_2m";
    const label = "GET open-meteo /v1/forecast";
    const start = performance.now();
    let weather;
    try {
      const res = await fetch(url);
      const json = await res.json().catch(() => null);
      weather = { status: res.status, json, ms: performance.now() - start };
    } catch (e) {
      weather = { status: 0, json: null, error: e.message, ms: performance.now() - start };
    }
    if (!timings.has(label)) timings.set(label, []);
    timings.get(label).push(weather.ms);
    check(
      "GET Open-Meteo current temperature",
      weather.status === 200 && typeof weather.json?.current?.temperature_2m === "number",
      weather
    );
  }

  // -------------------------------------------------------------------- cleanup
  section("Cleanup");
  if (prodId) {
    const delProd = await api("DELETE", `/api/products/${prodId}`, { token: adminToken });
    check("DELETE /api/products/:id", delProd.status === 204, delProd);
  }
}

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

function timingReport() {
  section(`Latency by endpoint${RUNS > 1 ? ` (${RUNS} runs each)` : ""} — slowest first`);
  const rows = [...timings.entries()].map(([label, samples]) => {
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    return { label, n: samples.length, avg, min: Math.min(...samples), max: Math.max(...samples), p95: pct(samples, 95) };
  });
  rows.sort((a, b) => b.avg - a.avg);

  const pad = (s, n) => String(s).padEnd(n);
  const num = (v) => `${v.toFixed(1)}ms`.padStart(9);
  console.log(`  ${pad("endpoint", 42)}${"n".padStart(4)}${"avg".padStart(10)}${"min".padStart(10)}${"max".padStart(10)}${"p95".padStart(10)}`);
  for (const r of rows) {
    console.log(`  ${pad(r.label, 42)}${String(r.n).padStart(4)}${num(r.avg)}${num(r.min)}${num(r.max)}${num(r.p95)}`);
  }
  const all = rows.flatMap((r) => timings.get(r.label));
  const total = all.reduce((a, b) => a + b, 0);
  console.log(
    `\n  ${rows.length} distinct endpoints, ${all.length} calls · total ${total.toFixed(0)}ms · ` +
      `overall avg ${(total / all.length).toFixed(1)}ms`
  );
}

async function main() {
  console.log(`API smoke test → ${BASE}${RUNS > 1 ? ` · ${RUNS} runs` : ""}`);
  for (let r = 0; r < RUNS; r++) {
    if (RUNS > 1) console.log(`\n\x1b[1m===== Run ${r + 1}/${RUNS} =====\x1b[0m`);
    await runSuite();
  }

  timingReport();

  console.log(`\n\x1b[1mResults:\x1b[0m ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log(`\x1b[31mFailed:\x1b[0m ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\x1b[32mAll API checks passed.\x1b[0m");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
