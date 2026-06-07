const prisma = require("../prisma");
const { getProductsByIds, decrementStock, restock } = require("../productClient");
const { writeAudit } = require("../audit");
const { publish } = require("../events/bus");

// order.* events carry the line items so consumers (user stats, product
// salesCount) can attribute quantities without a callback.
const eventItems = (items) =>
  items.map((i) => ({ productId: i.productId, quantity: i.quantity }));

// POST /orders  -> turn the current user's cart into an order, then clear the cart.
async function checkout(req, res) {
  const userId = req.user.id;

  const cart = await prisma.cart.findUnique({
    where: { userId },
    include: { items: true },
  });
  if (!cart || cart.items.length === 0) {
    return res.status(400).json({ message: "Cart is empty" });
  }

  // snapshot product data at purchase time
  const ids = cart.items.map((i) => i.productId);
  const products = await getProductsByIds(ids);
  const byId = Object.fromEntries(products.map((p) => [p.id, p]));

  let total = 0;
  const orderItems = cart.items.map((item) => {
    const product = byId[item.productId];
    const price = product ? Number(product.price) : 0;
    total += price * item.quantity;
    return {
      productId: item.productId,
      productName: product ? product.name : `Product #${item.productId}`,
      price,
      quantity: item.quantity,
    };
  });

  // Atomically reserve stock in product-service before recording the order.
  // If anything is short, nothing is decremented and checkout fails cleanly.
  const stockItems = cart.items.map((i) => ({ productId: i.productId, quantity: i.quantity }));
  try {
    await decrementStock(stockItems);
  } catch (err) {
    const status = err.status === 409 || err.status === 404 ? err.status : 502;
    return res.status(status).json({ message: err.message });
  }

  // create order + items, then empty the cart, atomically
  let order;
  try {
    order = await prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          userId,
          status: "PENDING",
          total: Number(total.toFixed(2)),
          items: { create: orderItems },
        },
        include: { items: true },
      });
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      await writeAudit(tx, req, {
        action: "PLACE_ORDER",
        entityId: created.id,
        details: { total: created.total, itemCount: orderItems.length },
      });
      return created;
    });
  } catch (err) {
    // Order failed after stock was decremented — compensate so we don't lose stock.
    await restock(stockItems);
    throw err;
  }

  // Publish AFTER commit (pure broker — no transactional outbox).
  await publish("order.placed", {
    orderId: order.id,
    userId,
    total: Number(order.total),
    items: eventItems(order.items),
  });

  res.status(201).json(order);
}

async function listOrders(req, res) {
  const orders = await prisma.order.findMany({
    where: { userId: req.user.id },
    include: { items: true },
    orderBy: { createdAt: "desc" },
  });
  res.json(orders);
}

async function getOrder(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid order id" });
  const order = await prisma.order.findFirst({
    where: { id, userId: req.user.id },
    include: { items: true },
  });
  if (!order) return res.status(404).json({ message: "Order not found" });
  res.json(order);
}

// DELETE /orders/:id  — a user may delete their OWN order; an admin may delete
// ANY order. Every deletion is recorded in the audit log with the actor's role.
async function deleteOrder(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid order id" });
  const isAdmin = req.user.role === "ADMIN";

  // Scope the lookup: admins by id, regular users to their own orders only.
  const order = await prisma.order.findFirst({
    where: isAdmin ? { id } : { id, userId: req.user.id },
    include: { items: true },
  });
  if (!order) return res.status(404).json({ message: "Order not found" });

  await prisma.$transaction(async (tx) => {
    await tx.order.delete({ where: { id } }); // order_items cascade-delete
    await writeAudit(tx, req, {
      action: "DELETE_ORDER",
      entityId: id,
      details: {
        status: order.status,
        total: order.total,
        itemCount: order.items.length,
        ownerUserId: order.userId,
        byRole: req.user.role,
      },
    });
  });

  // Publish AFTER commit (pure broker — no transactional outbox).
  await publish("order.deleted", {
    orderId: id,
    userId: order.userId,
    total: Number(order.total),
    status: order.status,
    items: eventItems(order.items),
  });

  // Return the purchased quantities to product stock (best-effort).
  // Skip if the order was already CANCELLED — its stock was returned then.
  if (order.status !== "CANCELLED") {
    await restock(order.items.map((i) => ({ productId: i.productId, quantity: i.quantity })));
  }

  res.status(204).end();
}

// PATCH /orders/:id/status  — admin-only. An admin may change ANY order's
// status, and every change is recorded in the audit log.
async function updateStatus(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid order id" });
  const { status } = req.body;
  const valid = ["PENDING", "PAID", "SHIPPED", "DELIVERED", "CANCELLED"];
  if (!valid.includes(status)) {
    return res.status(400).json({ message: "Invalid status" });
  }
  const order = await prisma.order.findUnique({ where: { id }, include: { items: true } });
  if (!order) return res.status(404).json({ message: "Order not found" });

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.order.update({
      where: { id },
      data: { status },
      include: { items: true },
    });
    await writeAudit(tx, req, {
      action: "UPDATE_STATUS",
      entityId: id,
      details: { from: order.status, to: status },
    });
    return result;
  });

  // Publish AFTER commit (pure broker — no transactional outbox).
  await publish("order.status.changed", {
    orderId: id,
    userId: order.userId,
    total: Number(order.total),
    from: order.status,
    to: status,
    items: eventItems(order.items),
  });

  // Cancelling an order returns its items to stock (once — only on the
  // transition INTO cancelled, so re-cancelling doesn't restock twice).
  if (status === "CANCELLED" && order.status !== "CANCELLED") {
    await restock(order.items.map((i) => ({ productId: i.productId, quantity: i.quantity })));
  }

  res.json(updated);
}

// GET /orders/all  — admin-only listing of every order across all users.
async function adminListOrders(req, res) {
  const { page = "1", limit = "50" } = req.query;
  const take = Math.min(Number(limit) || 50, 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const [total, orders] = await Promise.all([
    prisma.order.count(),
    prisma.order.findMany({
      include: { items: true },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
  ]);

  res.json({
    data: orders,
    pagination: { total, page: Number(page), limit: take, pages: Math.ceil(total / take) },
  });
}

// GET /orders/audit-logs  — admin-only view of the order action history.
// Filters: action (exact), actor (email contains), entityId (exact).
async function listAuditLogs(req, res) {
  const { page = "1", limit = "50", action, actor, entityId } = req.query;
  const take = Math.min(Number(limit) || 50, 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const where = {};
  if (action) where.action = action;
  if (actor) where.actorEmail = { contains: actor, mode: "insensitive" };
  if (entityId) where.entityId = Number(entityId);

  const [total, logs] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
  ]);

  res.json({
    data: logs,
    pagination: { total, page: Number(page), limit: take, pages: Math.ceil(total / take) },
  });
}

module.exports = { checkout, listOrders, getOrder, deleteOrder, updateStatus, adminListOrders, listAuditLogs };
