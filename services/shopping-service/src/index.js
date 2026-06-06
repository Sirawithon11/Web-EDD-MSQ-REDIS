require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const { authenticate } = require("./middleware/auth");
const cartRoutes = require("./routes/cart");
const orderRoutes = require("./routes/orders");
const eventsRouter = require("./events/consumer");
const { startRelay } = require("./events/relay");

const app = express();
const PORT = process.env.PORT || 4003;

app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

app.get("/health", (req, res) => res.json({ status: "ok", service: "shopping-service" }));

// Inbound domain events from other services (secret-protected, internal — not
// behind the user JWT auth the cart/order routes use).
app.use("/events", eventsRouter);

// all shopping routes require auth
app.use("/cart", authenticate, cartRoutes);
app.use("/orders", authenticate, orderRoutes);

app.use((req, res) => res.status(404).json({ message: "Not found" }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`shopping-service listening on :${PORT}`);
  startRelay();
});
