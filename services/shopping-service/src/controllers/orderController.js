const prisma = require("../prisma");
const { getProductsByIds } = require("../productClient");

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

  // create order + items, then empty the cart, atomically
  const order = await prisma.$transaction(async (tx) => {
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
    return created;
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
  const order = await prisma.order.findFirst({
    where: { id, userId: req.user.id },
    include: { items: true },
  });
  if (!order) return res.status(404).json({ message: "Order not found" });
  res.json(order);
}

async function updateStatus(req, res) {
  const id = Number(req.params.id);
  const { status } = req.body;
  const valid = ["PENDING", "PAID", "SHIPPED", "DELIVERED", "CANCELLED"];
  if (!valid.includes(status)) {
    return res.status(400).json({ message: "Invalid status" });
  }
  const order = await prisma.order.findFirst({ where: { id, userId: req.user.id } });
  if (!order) return res.status(404).json({ message: "Order not found" });

  const updated = await prisma.order.update({
    where: { id },
    data: { status },
    include: { items: true },
  });
  res.json(updated);
}

module.exports = { checkout, listOrders, getOrder, updateStatus };
