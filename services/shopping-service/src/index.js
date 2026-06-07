require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const { authenticate } = require("./middleware/auth");
const cartRoutes = require("./routes/cart");
const orderRoutes = require("./routes/orders");
const { connectBus, startConsumer } = require("./events/bus");
const handlers = require("./events/handlers");

const app = express();
const PORT = process.env.PORT || 4003;

app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

app.get("/health", (req, res) => res.json({ status: "ok", service: "shopping-service" }));

// all shopping routes require auth
app.use("/cart", authenticate, cartRoutes);
app.use("/orders", authenticate, orderRoutes);

app.use((req, res) => res.status(404).json({ message: "Not found" }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: "Internal server error" });
});

app.listen(PORT, async () => {
  console.log(`shopping-service listening on :${PORT}`);
  // Connect to Kafka, then consume product-service's product.* events to keep
  // the local ProductProjection read model in sync.
  await connectBus();
  startConsumer({
    groupId: "shopping-service",
    topics: ["product.created", "product.updated", "product.stock.changed", "product.deleted"],
    handlers,
  });
});
