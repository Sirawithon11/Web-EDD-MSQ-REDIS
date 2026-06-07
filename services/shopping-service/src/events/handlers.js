// Inbound event handlers for shopping-service. Each receives the parsed event
// payload and does its own DB work via prisma (no shared tx / inbox now that
// delivery goes through RabbitMQ — see ./bus.js).
//
// These maintain ProductProjection — a local read model of product-service's
// catalogue. Analytics reads from it instead of making a synchronous
// cross-service call on every request (see ../productView.js).
const prisma = require("../prisma");

async function upsert(p) {
  await prisma.productProjection.upsert({
    where: { id: p.id },
    create: { id: p.id, name: p.name, price: p.price, stock: p.stock, active: p.active },
    update: { name: p.name, price: p.price, stock: p.stock, active: p.active },
  });
}

module.exports = {
  "product.created": upsert,
  "product.updated": upsert,

  "product.stock.changed": async (p) => {
    // Only touch an existing projection row; if we've never seen the product,
    // a later product.updated (or the analytics HTTP fallback) will fill it in.
    await prisma.productProjection
      .update({ where: { id: p.productId }, data: { stock: p.stock } })
      .catch((err) => {
        if (err.code !== "P2025") throw err;
      });
  },

  "product.deleted": async (p) => {
    await prisma.productProjection
      .delete({ where: { id: p.productId } })
      .catch((err) => {
        if (err.code !== "P2025") throw err;
      });
  },
};
