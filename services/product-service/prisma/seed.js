// Seeds categories and an enterprise-scale catalog of products.
//
// Scale is env-overridable:
//   SEED_PRODUCTS  number of products (default 20000)
//
// Products are round-robin distributed across the categories and inserted with
// batched createMany. slug/sku are made unique with a global counter.
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const NUM_PRODUCTS = Number(process.env.SEED_PRODUCTS || 20000);
const BATCH = 5000;

const CATEGORIES = [
  { name: "Electronics", slug: "electronics" },
  { name: "Computers", slug: "computers" },
  { name: "Home & Kitchen", slug: "home-kitchen" },
  { name: "Books", slug: "books" },
  { name: "Clothing", slug: "clothing" },
  { name: "Sports & Outdoors", slug: "sports-outdoors" },
  { name: "Toys & Games", slug: "toys-games" },
  { name: "Beauty & Health", slug: "beauty-health" },
];

// adjectives + nouns per category to generate plausible product names
const WORDS = {
  electronics: ["Wireless Earbuds", "Bluetooth Speaker", "Smart Watch", "4K Action Camera", "Noise-Cancelling Headphones", "Portable Charger", "Smart Doorbell", "LED Light Strip"],
  computers: ["Mechanical Keyboard", "Gaming Mouse", "USB-C Hub", "27\" Monitor", "External SSD", "Laptop Stand", "Webcam 1080p", "Wi-Fi Router"],
  "home-kitchen": ["Air Fryer", "Espresso Machine", "Knife Set", "Non-stick Pan", "Robot Vacuum", "Electric Kettle", "Blender Pro", "Food Container Set"],
  books: ["The Pragmatic Programmer", "Clean Code", "Designing Data-Intensive Apps", "Atomic Habits", "Sapiens", "Deep Work", "The Lean Startup", "Refactoring"],
  clothing: ["Cotton T-Shirt", "Denim Jacket", "Running Shorts", "Wool Sweater", "Rain Jacket", "Slim Fit Jeans", "Hoodie", "Polo Shirt"],
  "sports-outdoors": ["Yoga Mat", "Dumbbell Set", "Camping Tent", "Water Bottle", "Resistance Bands", "Trekking Poles", "Cycling Helmet", "Jump Rope"],
  "toys-games": ["Building Blocks Set", "Board Game Classic", "RC Car", "Puzzle 1000pc", "Plush Bear", "Drone Mini", "Card Game Deck", "Action Figure"],
  "beauty-health": ["Vitamin C Serum", "Electric Toothbrush", "Hair Dryer", "Facial Cleanser", "Sunscreen SPF50", "Massage Gun", "Body Lotion", "Lip Balm Set"],
};

const BRANDS = ["Acme", "Nova", "Zenith", "Apex", "Lumen", "Vertex", "Orbit", "Pulse", "Helix", "Quartz"];

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function price(min, max) {
  return (Math.random() * (max - min) + min).toFixed(2);
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function main() {
  console.log(`Seeding ${NUM_PRODUCTS.toLocaleString()} products...`);

  await prisma.product.deleteMany();
  await prisma.category.deleteMany();

  const categoryMap = {};
  for (const c of CATEGORIES) {
    const created = await prisma.category.create({ data: c });
    categoryMap[c.slug] = created.id;
  }

  const slugs = Object.keys(WORDS);
  let buffer = [];
  let created = 0;
  for (let counter = 1; counter <= NUM_PRODUCTS; counter++) {
    const slug = slugs[(counter - 1) % slugs.length]; // round-robin across categories
    const names = WORDS[slug];
    const base = names[counter % names.length];
    const brand = BRANDS[counter % BRANDS.length];
    const name = `${brand} ${base} #${counter}`;
    buffer.push({
      name,
      slug: slugify(name) + "-" + counter,
      description: `${name} — high quality ${base.toLowerCase()} from ${brand}. Reliable, well reviewed, and built to last.`,
      price: price(9.99, 899.99),
      stock: randInt(5, 500),
      imageUrl: `https://picsum.photos/seed/prod${counter}/400/400`,
      sku: `SKU-${slug.slice(0, 3).toUpperCase()}-${String(counter).padStart(6, "0")}`,
      categoryId: categoryMap[slug],
    });

    if (buffer.length >= BATCH) {
      await prisma.product.createMany({ data: buffer });
      created += buffer.length;
      buffer = [];
      console.log(`  ...${created.toLocaleString()}/${NUM_PRODUCTS.toLocaleString()}`);
    }
  }
  if (buffer.length) {
    await prisma.product.createMany({ data: buffer });
    created += buffer.length;
  }

  const total = await prisma.product.count();
  console.log(`Done. ${CATEGORIES.length} categories, ${total.toLocaleString()} products in product_db.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
