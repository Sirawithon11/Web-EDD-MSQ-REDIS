const prisma = require("../prisma");
const { getProductsByIds } = require("../productClient");

// Find or create the cart belonging to the current user.
async function getOrCreateCart(userId) {
  let cart = await prisma.cart.findUnique({
    where: { userId },
    include: { items: true },
  });
  if (!cart) {
    cart = await prisma.cart.create({
      data: { userId },
      include: { items: true },
    });
  }
  return cart;
}

// Enrich cart items with live product data (name, price, image) from product-service.
async function enrichCart(cart) {
  const ids = cart.items.map((i) => i.productId);
  const products = await getProductsByIds(ids);
  const byId = Object.fromEntries(products.map((p) => [p.id, p]));

  const items = cart.items.map((item) => {
    const product = byId[item.productId] || null;
    const price = product ? Number(product.price) : 0;
    return {
      id: item.id,
      productId: item.productId,
      quantity: item.quantity,
      product,
      lineTotal: Number((price * item.quantity).toFixed(2)),
    };
  });

  const subtotal = items.reduce((sum, i) => sum + i.lineTotal, 0);

  return {
    id: cart.id,
    userId: cart.userId,
    items,
    subtotal: Number(subtotal.toFixed(2)),
    itemCount: items.reduce((n, i) => n + i.quantity, 0),
  };
}

async function getCart(req, res) {
  const cart = await getOrCreateCart(req.user.id);
  res.json(await enrichCart(cart));
}

async function addItem(req, res) {
  const { productId, quantity = 1 } = req.body;
  if (!productId) return res.status(400).json({ message: "productId is required" });

  // validate product exists
  const products = await getProductsByIds([Number(productId)]);
  if (!products.length) {
    return res.status(404).json({ message: "Product not found" });
  }

  const cart = await getOrCreateCart(req.user.id);

  await prisma.cartItem.upsert({
    where: { cartId_productId: { cartId: cart.id, productId: Number(productId) } },
    update: { quantity: { increment: Number(quantity) } },
    create: { cartId: cart.id, productId: Number(productId), quantity: Number(quantity) },
  });

  const refreshed = await prisma.cart.findUnique({
    where: { id: cart.id },
    include: { items: true },
  });
  res.status(201).json(await enrichCart(refreshed));
}

async function updateItem(req, res) {
  const itemId = Number(req.params.itemId);
  const { quantity } = req.body;
  if (quantity == null || Number(quantity) < 1) {
    return res.status(400).json({ message: "quantity must be >= 1" });
  }

  const cart = await getOrCreateCart(req.user.id);
  const item = await prisma.cartItem.findFirst({ where: { id: itemId, cartId: cart.id } });
  if (!item) return res.status(404).json({ message: "Cart item not found" });

  await prisma.cartItem.update({ where: { id: itemId }, data: { quantity: Number(quantity) } });

  const refreshed = await prisma.cart.findUnique({
    where: { id: cart.id },
    include: { items: true },
  });
  res.json(await enrichCart(refreshed));
}

async function removeItem(req, res) {
  const itemId = Number(req.params.itemId);
  const cart = await getOrCreateCart(req.user.id);
  const item = await prisma.cartItem.findFirst({ where: { id: itemId, cartId: cart.id } });
  if (!item) return res.status(404).json({ message: "Cart item not found" });

  await prisma.cartItem.delete({ where: { id: itemId } });

  const refreshed = await prisma.cart.findUnique({
    where: { id: cart.id },
    include: { items: true },
  });
  res.json(await enrichCart(refreshed));
}

module.exports = { getCart, addItem, updateItem, removeItem, getOrCreateCart, enrichCart };
