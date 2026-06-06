require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const userRoutes = require("./routes/users");
const eventsRouter = require("./events/consumer");
const { startRelay } = require("./events/relay");

const app = express();
const PORT = process.env.PORT || 4001;

app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

app.get("/health", (req, res) => res.json({ status: "ok", service: "user-service" }));

app.use("/users", userRoutes);
// Inbound domain events from other services (secret-protected, internal).
app.use("/events", eventsRouter);

// 404
app.use((req, res) => res.status(404).json({ message: "Not found" }));

// error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`user-service listening on :${PORT}`);
  startRelay();
});
