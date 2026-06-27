require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const jwt = require("jsonwebtoken");
const { attachRealtime } = require("./realtime");
const { userClient, productClient, shoppingClient, forward } = require("./grpcClients");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(morgan("dev"));
// We now translate REST -> gRPC, so we DO parse the body here (the old proxy
// streamed it through). 8mb fits base64 data-URL product images.
app.use(express.json({ limit: "8mb" }));

// Fast-fail JWT check on protected routes (services still re-verify themselves).
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

const body = (req) => JSON.stringify(req.body || {});
const query = (req) => JSON.stringify(req.query || {});

app.get("/health", (req, res) =>
  res.json({
    status: "ok",
    service: "gateway",
    transport: "grpc",
    routes: ["/api/users", "/api/products", "/api/cart", "/api/orders"],
  })
);

// ------------------------------- users ----------------------------------
app.post("/api/users/register", (req, res) => forward(req, res, userClient, "Register", { body: body(req) }, { status: 201 }));
app.post("/api/users/login", (req, res) => forward(req, res, userClient, "Login", { body: body(req) }));
app.get("/api/users/me", (req, res) => forward(req, res, userClient, "Me", {}));
app.get("/api/users", (req, res) => forward(req, res, userClient, "List", {}));
// must precede "/:id" so "by-email" isn't captured as an :id
app.get("/api/users/by-email", (req, res) => forward(req, res, userClient, "GetByEmail", { email: req.query.email || "" }));
app.get("/api/users/:id", (req, res) => forward(req, res, userClient, "GetById", { id: Number(req.params.id) }));

// ------------------------------ products --------------------------------
app.get("/api/products/categories", (req, res) => forward(req, res, productClient, "ListCategories", {}));
// admin / audit must precede "/:id"
app.get("/api/products/admin", (req, res) => forward(req, res, productClient, "AdminList", { query: query(req) }));
app.get("/api/products/audit-logs", (req, res) => forward(req, res, productClient, "ListAuditLogs", { query: query(req) }));
app.get("/api/products", (req, res) => forward(req, res, productClient, "List", { query: query(req) }));
app.get("/api/products/:id", (req, res) => forward(req, res, productClient, "Get", { id: Number(req.params.id) }));
app.post("/api/products", (req, res) => forward(req, res, productClient, "Create", { body: body(req) }, { status: 201 }));
app.put("/api/products/:id", (req, res) => forward(req, res, productClient, "Update", { id: Number(req.params.id), body: body(req) }));
app.delete("/api/products/:id", (req, res) => forward(req, res, productClient, "Remove", { id: Number(req.params.id) }));

// -------------------------------- cart ----------------------------------
app.get("/api/cart", requireAuth, (req, res) => forward(req, res, shoppingClient, "GetCart", {}));
app.post("/api/cart/items", requireAuth, (req, res) => forward(req, res, shoppingClient, "AddItem", { body: body(req) }, { status: 201 }));
app.put("/api/cart/items/:itemId", requireAuth, (req, res) => forward(req, res, shoppingClient, "UpdateItem", { itemId: Number(req.params.itemId), body: body(req) }));
app.delete("/api/cart/items/:itemId", requireAuth, (req, res) => forward(req, res, shoppingClient, "RemoveItem", { itemId: Number(req.params.itemId) }));

// ------------------------------- orders ---------------------------------
app.post("/api/orders", requireAuth, (req, res) => forward(req, res, shoppingClient, "Checkout", {}, { status: 201 }));
app.get("/api/orders", requireAuth, (req, res) => forward(req, res, shoppingClient, "ListOrders", {}));
// admin / analytics must precede "/:id"
app.get("/api/orders/all", requireAuth, (req, res) => forward(req, res, shoppingClient, "AdminListOrders", { query: query(req) }));
app.get("/api/orders/audit-logs", requireAuth, (req, res) => forward(req, res, shoppingClient, "ListAuditLogs", { query: query(req) }));
app.get("/api/orders/analytics/sales", requireAuth, (req, res) => forward(req, res, shoppingClient, "SalesReport", { query: query(req) }));
app.get("/api/orders/analytics/affinity", requireAuth, (req, res) => forward(req, res, shoppingClient, "ProductAffinity", { query: query(req) }));
app.get("/api/orders/:id", requireAuth, (req, res) => forward(req, res, shoppingClient, "GetOrder", { id: Number(req.params.id) }));
app.patch("/api/orders/:id/status", requireAuth, (req, res) => forward(req, res, shoppingClient, "UpdateStatus", { id: Number(req.params.id), body: body(req) }));
app.delete("/api/orders/:id", requireAuth, (req, res) => forward(req, res, shoppingClient, "DeleteOrder", { id: Number(req.params.id) }));

app.use((req, res) => res.status(404).json({ message: "Gateway: route not found" }));

// Wrap Express in an explicit HTTP server so the WebSocket server can share the
// same port. attachRealtime adds the /ws endpoint and the Kafka stock consumer.
const server = http.createServer(app);
attachRealtime(server);

server.listen(PORT, () => {
  console.log(`gateway listening on :${PORT}  (REST -> gRPC)`);
  console.log(`  -> users    ${process.env.USER_GRPC_ADDR || "localhost:50051"}`);
  console.log(`  -> products ${process.env.PRODUCT_GRPC_ADDR || "localhost:50052"}`);
  console.log(`  -> shopping ${process.env.SHOPPING_GRPC_ADDR || "localhost:50053"}`);
  console.log(`  -> ws       /ws (live stock)`);
});
