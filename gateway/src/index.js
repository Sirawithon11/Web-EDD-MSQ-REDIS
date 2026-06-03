require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const { createProxyMiddleware } = require("http-proxy-middleware");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 8080;

const USER_SERVICE_URL = process.env.USER_SERVICE_URL || "http://localhost:4001";
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || "http://localhost:4002";
const SHOPPING_SERVICE_URL = process.env.SHOPPING_SERVICE_URL || "http://localhost:4003";

app.use(cors());
app.use(morgan("dev"));
// NOTE: no body parser here — bodies stream straight through to the services.

// http-proxy-middleware v3 rewrites against req.url, which Express has already
// stripped of the `app.use()` mount path. So inside each proxy the path is e.g.
// "/categories", not "/api/products/categories". We prepend the service prefix
// instead of trying to rewrite a "/api/..." prefix that is no longer present.
const prefixWith = (base) => (path) => `${base}${path}`;

// Fail fast on protected routes (services still re-verify the token themselves).
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: "Authentication required" });
  try {
    jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

app.get("/health", (req, res) =>
  res.json({
    status: "ok",
    service: "gateway",
    routes: ["/api/users", "/api/products", "/api/cart", "/api/orders"],
  })
);

// /api/users/*  ->  user-service /users/*
app.use(
  "/api/users",
  createProxyMiddleware({
    target: USER_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: prefixWith("/users"),
  })
);

// /api/products/*  ->  product-service /products/*
app.use(
  "/api/products",
  createProxyMiddleware({
    target: PRODUCT_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: prefixWith("/products"),
  })
);

// /api/cart/*  ->  shopping-service /cart/*   (auth required)
app.use(
  "/api/cart",
  requireAuth,
  createProxyMiddleware({
    target: SHOPPING_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: prefixWith("/cart"),
  })
);

// /api/orders/*  ->  shopping-service /orders/*  (auth required)
app.use(
  "/api/orders",
  requireAuth,
  createProxyMiddleware({
    target: SHOPPING_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: prefixWith("/orders"),
  })
);

app.use((req, res) => res.status(404).json({ message: "Gateway: route not found" }));

app.listen(PORT, () => {
  console.log(`gateway listening on :${PORT}`);
  console.log(`  -> users    ${USER_SERVICE_URL}`);
  console.log(`  -> products ${PRODUCT_SERVICE_URL}`);
  console.log(`  -> shopping ${SHOPPING_SERVICE_URL}`);
});
