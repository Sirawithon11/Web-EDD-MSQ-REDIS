// Inbound event handlers for product-service. Each receives the transaction
// client and the event payload, and runs inside the consumer's dedupe tx.
//
// These maintain a per-product `salesCount` popularity counter from
// shopping-service's order lifecycle events. NOTE: this is independent of
// `stock` — stock is still owned by the synchronous checkout saga; salesCount
// is a denormalised analytics counter driven purely by events.

async function safe(promise) {
  try {
    await promise;
  } catch (err) {
    if (err.code !== "P2025") throw err; // ignore "record not found"
  }
}

const COUNTS = (status) => status && status !== "CANCELLED";

async function adjust(tx, items, sign) {
  for (const item of items || []) {
    await safe(
      tx.product.update({
        where: { id: item.productId },
        data: { salesCount: { [sign > 0 ? "increment" : "decrement"]: item.quantity } },
      })
    );
  }
}

module.exports = {
  "order.placed": async (tx, p) => {
    await adjust(tx, p.items, +1);
  },

  "order.status.changed": async (tx, p) => {
    if (p.to === "CANCELLED" && p.from !== "CANCELLED") {
      await adjust(tx, p.items, -1);
    }
  },

  "order.deleted": async (tx, p) => {
    if (COUNTS(p.status)) await adjust(tx, p.items, -1);
  },
};
