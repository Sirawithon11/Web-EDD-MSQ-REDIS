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
};

export { API_URL };
