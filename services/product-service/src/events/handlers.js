// Inbound event handlers for product-service. Each receives the parsed event
// payload and does its own DB work via prisma (no shared tx / inbox now that
// delivery goes through RabbitMQ — see ./bus.js).
//
// These maintain a per-product `salesCount` popularity counter from
// shopping-service's order lifecycle events. NOTE: this is independent of
// `stock` — stock is still owned by the synchronous checkout saga; salesCount
// is a denormalised analytics counter driven purely by events.
const prisma = require("../prisma");

async function safe(promise) {
  try {
    await promise;
  } catch (err) {
    if (err.code !== "P2025") throw err; // ignore "record not found"
  }
}

const COUNTS = (status) => status && status !== "CANCELLED";

async function adjust(items, sign) {
  for (const item of items || []) {
    await safe(
      prisma.product.update({
        where: { id: item.productId },
        data: { salesCount: { [sign > 0 ? "increment" : "decrement"]: item.quantity } },
      })
    );
  }
}

module.exports = {
  "order.placed": async (p) => {
    await adjust(p.items, +1);
  },

  "order.status.changed": async (p) => {
    if (p.to === "CANCELLED" && p.from !== "CANCELLED") {
      await adjust(p.items, -1);
    }
  },

  "order.deleted": async (p) => {
    if (COUNTS(p.status)) await adjust(p.items, -1);
  },
};
