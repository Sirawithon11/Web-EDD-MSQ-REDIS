// Tiny fetch wrapper around the API gateway.
const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

function getToken() {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("token");
}

async function request(path, { method = "GET", body, auth = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return null;

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || `Request failed (${res.status})`);
  }
  return data;
}

export const api = {
  // auth
  register: (payload) => request("/api/users/register", { method: "POST", body: payload }),
  login: (payload) => request("/api/users/login", { method: "POST", body: payload }),
  me: () => request("/api/users/me", { auth: true }),

  // products
  listProducts: (query = "") => request(`/api/products${query}`),
  getProduct: (id) => request(`/api/products/${id}`),
  listCategories: () => request("/api/products/categories"),

  // products — admin only (gateway forwards JWT; product-service enforces ADMIN)
  adminListProducts: (query = "") => request(`/api/products/admin${query}`, { auth: true }),
  createProduct: (payload) =>
    request("/api/products", { method: "POST", body: payload, auth: true }),
  updateProduct: (id, payload) =>
    request(`/api/products/${id}`, { method: "PUT", body: payload, auth: true }),
  deleteProduct: (id) =>
    request(`/api/products/${id}`, { method: "DELETE", auth: true }),

  // admin audit logs
  listProductAuditLogs: (query = "") => request(`/api/products/audit-logs${query}`, { auth: true }),
  listOrderAuditLogs: (query = "") => request(`/api/orders/audit-logs${query}`, { auth: true }),

  // cart
  getCart: () => request("/api/cart", { auth: true }),
  addToCart: (productId, quantity = 1) =>
    request("/api/cart/items", { method: "POST", body: { productId, quantity }, auth: true }),
  updateCartItem: (itemId, quantity) =>
    request(`/api/cart/items/${itemId}`, { method: "PUT", body: { quantity }, auth: true }),
  removeCartItem: (itemId) =>
    request(`/api/cart/items/${itemId}`, { method: "DELETE", auth: true }),

  // orders
  checkout: () => request("/api/orders", { method: "POST", auth: true }),
  listOrders: () => request("/api/orders", { auth: true }),
  getOrder: (id) => request(`/api/orders/${id}`, { auth: true }),
  deleteOrder: (id) => request(`/api/orders/${id}`, { method: "DELETE", auth: true }),

  // orders — admin only
  adminListOrders: (query = "") => request(`/api/orders/all${query}`, { auth: true }),
  updateOrderStatus: (id, status) =>
    request(`/api/orders/${id}/status`, { method: "PATCH", body: { status }, auth: true }),

  // analytics — admin only (the heavy sales roll-up)
  salesReport: (query = "") => request(`/api/orders/analytics/sales${query}`, { auth: true }),
  // analytics — admin only (the heavy product co-purchase / market-basket self-join)
  productAffinity: (query = "") => request(`/api/orders/analytics/affinity${query}`, { auth: true }),
};

export { API_URL };
