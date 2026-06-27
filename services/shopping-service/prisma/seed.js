// Seeds an enterprise-scale set of orders (with line items) plus active carts.
// Pulls real product ids/prices from product-service, so make sure
// product-service is running and seeded first.
//
// Scale is env-overridable:
//   SEED_USERS    user-id upper bound (must match user seed)  (default 100000)
//   SEED_ORDERS   number of orders                            (default 500000)
//   SEED_CARTS    number of active carts                      (default 5000)
//   SEED_SAMPLE   how many products to sample for line items  (default 5000)
//
// Performance: orders + items are written with batched createMany. Because
// createMany doesn't return ids, orders are inserted in chunks and the ids of
// each chunk are read back (ascending == insertion order) to attach items.
const { PrismaClient } = require("@prisma/client");
const grpc = require("@grpc/grpc-js");
const { load } = require("../src/grpc/load");

const prisma = new PrismaClient();

// gRPC client to product-service (same contract the running service uses).
const PRODUCT_GRPC_ADDR = process.env.PRODUCT_GRPC_ADDR || "localhost:50052";
const productProto = load("product.proto").product;
const productClient = new productProto.ProductService(
  PRODUCT_GRPC_ADDR,
  grpc.credentials.createInsecure(),
  { "grpc.max_receive_message_length": 16 * 1024 * 1024 }
);
function productList(query) {
  return new Promise((resolve, reject) => {
    productClient.List({ query: JSON.stringify(query) }, (err, res) =>
      err ? reject(err) : resolve(JSON.parse(res.json || "{}"))
    );
  });
}

const STATUSES = ["PENDING", "PAID", "SHIPPED", "DELIVERED", "CANCELLED"];
const NUM_USERS = Number(process.env.SEED_USERS || 100000);
const NUM_ORDERS = Number(process.env.SEED_ORDERS || 500000);
const NUM_CARTS = Number(process.env.SEED_CARTS || 5000);
const SAMPLE = Number(process.env.SEED_SAMPLE || 5000);

const BATCH = 5000;        // rows per createMany
const ORDER_CHUNK = 20000; // orders generated + inserted + linked per iteration

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Insert an array of rows in createMany batches.
async function insertBatches(model, rows) {
  for (let i = 0; i < rows.length; i += BATCH) {
    await model.createMany({ data: rows.slice(i, i + BATCH) });
  }
}

// Page through the public catalog (over gRPC) to collect a representative sample.
async function fetchProductSample(want) {
  const out = [];
  let page = 1;
  while (out.length < want) {
    const json = await productList({ page, limit: 100 });
    const rows = json.data || [];
    if (rows.length === 0) break;
    for (const p of rows) out.push({ id: p.id, name: p.name, price: Number(p.price) });
    if (json.pagination && page >= json.pagination.pages) break;
    page++;
  }
  return out;
}

async function main() {
  console.log(`Seeding ${NUM_ORDERS.toLocaleString()} orders + ${NUM_CARTS.toLocaleString()} carts...`);

  const sample = await fetchProductSample(SAMPLE);
  if (!sample.length) {
    throw new Error("No products returned from product-service. Seed product-service first.");
  }
  console.log(`Loaded ${sample.length.toLocaleString()} products from product-service.`);

  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.cartItem.deleteMany();
  await prisma.cart.deleteMany();

  // ---- Orders (chunked: insert orders, read back their ids, attach items) ----
  let done = 0;
  while (done < NUM_ORDERS) {
    const n = Math.min(ORDER_CHUNK, NUM_ORDERS - done);
    const orderRows = [];
    const itemsPerOrder = [];

    for (let k = 0; k < n; k++) {
      const lineCount = randInt(1, 5);
      const used = new Set();
      let total = 0;
      const items = [];
      for (let j = 0; j < lineCount; j++) {
        const p = sample[randInt(0, sample.length - 1)];
        if (used.has(p.id)) continue;
        used.add(p.id);
        const quantity = randInt(1, 4);
        total += p.price * quantity;
        items.push({ productId: p.id, productName: p.name, price: p.price, quantity });
      }
      orderRows.push({
        userId: randInt(1, NUM_USERS),
        status: STATUSES[randInt(0, STATUSES.length - 1)],
        total: Number(total.toFixed(2)),
        createdAt: new Date(Date.now() - randInt(0, 365) * 24 * 60 * 60 * 1000),
      });
      itemsPerOrder.push(items);
    }

    await insertBatches(prisma.order, orderRows);

    // The n most-recently-inserted ids belong to this chunk; ascending == insertion order.
    const inserted = await prisma.order.findMany({
      orderBy: { id: "desc" },
      take: n,
      select: { id: true },
    });
    inserted.reverse();

    const allItems = [];
    for (let k = 0; k < n; k++) {
      const orderId = inserted[k].id;
      for (const it of itemsPerOrder[k]) allItems.push({ orderId, ...it });
    }
    await insertBatches(prisma.orderItem, allItems);

    done += n;
    console.log(`  ...orders ${done.toLocaleString()}/${NUM_ORDERS.toLocaleString()}`);
  }

  // ---- Active carts (userId 1..NUM_CARTS) ----
  await insertBatches(
    prisma.cart,
    Array.from({ length: NUM_CARTS }, (_, i) => ({ userId: i + 1 }))
  );
  const carts = await prisma.cart.findMany({ select: { id: true } });
  const cartItems = [];
  for (const c of carts) {
    const lineCount = randInt(1, 3);
    const used = new Set();
    for (let j = 0; j < lineCount; j++) {
      const p = sample[randInt(0, sample.length - 1)];
      if (used.has(p.id)) continue;
      used.add(p.id);
      cartItems.push({ cartId: c.id, productId: p.id, quantity: randInt(1, 3) });
    }
  }
  await insertBatches(prisma.cartItem, cartItems);

  const [orderCount, itemCount, cartCount] = await Promise.all([
    prisma.order.count(),
    prisma.orderItem.count(),
    prisma.cart.count(),
  ]);
  console.log(
    `Done. ${orderCount.toLocaleString()} orders, ${itemCount.toLocaleString()} order items, ${cartCount.toLocaleString()} carts in shopping_db.`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
