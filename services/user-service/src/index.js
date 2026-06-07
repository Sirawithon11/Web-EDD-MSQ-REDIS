require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const userRoutes = require("./routes/users");
const { connectBus, startConsumer } = require("./events/bus");
const handlers = require("./events/handlers");

const app = express();
const PORT = process.env.PORT || 4001;

app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

app.get("/health", (req, res) => res.json({ status: "ok", service: "user-service" }));

app.use("/users", userRoutes);

// 404
app.use((req, res) => res.status(404).json({ message: "Not found" }));

// error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: "Internal server error" });
});

app.listen(PORT, async () => {
  console.log(`user-service listening on :${PORT}`);
  // Connect to RabbitMQ, then consume shopping-service's order.* events to keep
  // each user's ordersCount / totalSpent projection up to date.
  await connectBus();
  startConsumer({
    queue: "user-service.events",
    bindings: ["order.placed", "order.status.changed", "order.deleted"],
    handlers,
  });
});
