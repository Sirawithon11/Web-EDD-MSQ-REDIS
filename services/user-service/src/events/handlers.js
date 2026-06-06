// Inbound event handlers for user-service. Each receives the transaction client
// and the event payload, and runs inside the consumer's dedupe transaction.
//
// These maintain a per-user activity projection (ordersCount / totalSpent /
// lastOrderAt) from shopping-service's order lifecycle events.

// A user row may legitimately be missing (e.g. event for a since-deleted user).
// Swallow P2025 ("record not found") so the event is still marked processed.
async function safe(promise) {
  try {
    await promise;
  } catch (err) {
    if (err.code !== "P2025") throw err;
  }
}

// Does this order status count toward a user's spend/order totals?
const COUNTS = (status) => status && status !== "CANCELLED";

module.exports = {
  "order.placed": async (tx, p) => {
    await safe(
      tx.user.update({
        where: { id: p.userId },
        data: {
          ordersCount: { increment: 1 },
          totalSpent: { increment: p.total || 0 },
          lastOrderAt: new Date(),
        },
      })
    );
  },

  // Reverse the totals when an order transitions INTO cancelled.
  "order.status.changed": async (tx, p) => {
    if (p.to === "CANCELLED" && p.from !== "CANCELLED") {
      await safe(
        tx.user.update({
          where: { id: p.userId },
          data: {
            ordersCount: { decrement: 1 },
            totalSpent: { decrement: p.total || 0 },
          },
        })
      );
    }
  },

  // A deleted order that still counted toward totals must be reversed.
  "order.deleted": async (tx, p) => {
    if (COUNTS(p.status)) {
      await safe(
        tx.user.update({
          where: { id: p.userId },
          data: {
            ordersCount: { decrement: 1 },
            totalSpent: { decrement: p.total || 0 },
          },
        })
      );
    }
  },
};
