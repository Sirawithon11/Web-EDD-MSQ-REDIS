// Inbound event handlers for user-service. Each receives the parsed event
// payload and does its own DB work via prisma (no shared tx / inbox now that
// delivery goes through RabbitMQ — see ./bus.js).
//
// These maintain a per-user activity projection (ordersCount / totalSpent /
// lastOrderAt) from shopping-service's order lifecycle events. Because those
// fields appear in the cached GET /users payload, each handler also invalidates
// the user-list cache — this is the event-driven cache-invalidation hook.
const prisma = require("../prisma");
const { invalidateUsersList } = require("../cache");

// A user row may legitimately be missing (e.g. event for a since-deleted user).
// Swallow P2025 ("record not found") so the message is still ack'd.
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
  "order.placed": async (p) => {
    await safe(
      prisma.user.update({
        where: { id: p.userId },
        data: {
          ordersCount: { increment: 1 },
          totalSpent: { increment: p.total || 0 },
          lastOrderAt: new Date(),
        },
      })
    );
    await invalidateUsersList();
  },

  // Reverse the totals when an order transitions INTO cancelled.
  "order.status.changed": async (p) => {
    if (p.to === "CANCELLED" && p.from !== "CANCELLED") {
      await safe(
        prisma.user.update({
          where: { id: p.userId },
          data: {
            ordersCount: { decrement: 1 },
            totalSpent: { decrement: p.total || 0 },
          },
        })
      );
      await invalidateUsersList();
    }
  },

  // A deleted order that still counted toward totals must be reversed.
  "order.deleted": async (p) => {
    if (COUNTS(p.status)) {
      await safe(
        prisma.user.update({
          where: { id: p.userId },
          data: {
            ordersCount: { decrement: 1 },
            totalSpent: { decrement: p.total || 0 },
          },
        })
      );
      await invalidateUsersList();
    }
  },
};
