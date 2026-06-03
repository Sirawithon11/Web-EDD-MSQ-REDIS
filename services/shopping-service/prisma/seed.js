// Seeds ~200 orders (with line items) plus a few active carts.
// Pulls real product ids/prices from product-service, so make sure
// product-service is running and seeded first.
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || "http://localhost:4002";

const STATUSES = ["PENDING", "PAID", "SHIPPED", "DELIVERED", "CANCELLED"];
const NUM_USERS = 50; // matches user-service seed
const NUM_ORDERS = 200;

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function fetchProducts() {
  // ask for products with ids 1..150 (product seed creates ~120)
  const ids = Array.from({ length: 150 }, (_, i) => i + 1);
  const res = await fetch(`${PRODUCT_SERVICE_URL}/products/bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error(`product-service returned ${res.status}`);
  return res.json();
}

async function main() {
  console.log("Seeding orders & carts...");

  const products = await fetchProducts();
  if (!products.length) {
    throw new Error("No products returned from product-service. Seed product-service first.");
  }
  console.log(`Loaded ${products.length} products from product-service.`);

  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.cartItem.deleteMany();
  await prisma.cart.deleteMany();

  // ---- Orders ----
  for (let i = 0; i < NUM_ORDERS; i++) {
    const userId = randInt(1, NUM_USERS);
    const lineCount = randInt(1, 5);
    const chosen = [];
    const used = new Set();
    for (let j = 0; j < lineCount; j++) {
      const p = products[randInt(0, products.length - 1)];
      if (used.has(p.id)) continue;
      used.add(p.id);
      chosen.push(p);
    }

    let total = 0;
    const items = chosen.map((p) => {
      const quantity = randInt(1, 4);
      const price = Number(p.price);
      total += price * quantity;
      return { productId: p.id, productName: p.name, price, quantity };
    });

    await prisma.order.create({
      data: {
        userId,
        status: STATUSES[randInt(0, STATUSES.length - 1)],
        total: Number(total.toFixed(2)),
        items: { create: items },
        createdAt: new Date(Date.now() - randInt(0, 90) * 24 * 60 * 60 * 1000),
      },
    });
  }

  // ---- A handful of active carts ----
  for (let userId = 1; userId <= 10; userId++) {
    const cart = await prisma.cart.create({ data: { userId } });
    const lineCount = randInt(1, 3);
    const used = new Set();
    for (let j = 0; j < lineCount; j++) {
      const p = products[randInt(0, products.length - 1)];
      if (used.has(p.id)) continue;
      used.add(p.id);
      await prisma.cartItem.create({
        data: { cartId: cart.id, productId: p.id, quantity: randInt(1, 3) },
      });
    }
  }

  const orderCount = await prisma.order.count();
  const itemCount = await prisma.orderItem.count();
  const cartCount = await prisma.cart.count();
  console.log(`Done. ${orderCount} orders, ${itemCount} order items, ${cartCount} carts in shopping_db.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
