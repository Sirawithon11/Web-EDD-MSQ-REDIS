require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const productRoutes = require("./routes/products");

const app = express();
const PORT = process.env.PORT || 4002;

app.use(cors());
// Raised from the 100kb default so base64 data-URL product images fit.
app.use(express.json({ limit: "8mb" }));
app.use(morgan("dev"));

app.get("/health", (req, res) => res.json({ status: "ok", service: "product-service" }));

app.use("/products", productRoutes);

app.use((req, res) => res.status(404).json({ message: "Not found" }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: "Internal server error" });
});

app.listen(PORT, () => console.log(`product-service listening on :${PORT}`));
