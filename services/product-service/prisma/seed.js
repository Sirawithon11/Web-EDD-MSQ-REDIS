// Seeds 8 categories and ~120 products with medium-size realistic data.
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

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

const BRANDS = ["Acme", "Nova", "Zenith", "Apex", "Lumen", "Vertex", "Orbit", "Pulse"];

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function price(min, max) {
  return (Math.random() * (max - min) + min).toFixed(2);
}

async function main() {
  console.log("Seeding products...");

  await prisma.product.deleteMany();
  await prisma.category.deleteMany();

  const categoryMap = {};
  for (const c of CATEGORIES) {
    const created = await prisma.category.create({ data: c });
    categoryMap[c.slug] = created.id;
  }

  const products = [];
  let counter = 1;
  for (const [slug, names] of Object.entries(WORDS)) {
    // ~15 products per category -> ~120 total
    for (let i = 0; i < 15; i++) {
      const base = names[i % names.length];
      const brand = BRANDS[(i + counter) % BRANDS.length];
      const name = `${brand} ${base}${i >= names.length ? " v" + (Math.floor(i / names.length) + 1) : ""}`;
      products.push({
        name,
        slug: slugify(name) + "-" + counter,
        description: `${name} — high quality ${base.toLowerCase()} from ${brand}. Reliable, well reviewed, and built to last.`,
        price: price(9.99, 899.99),
        stock: Math.floor(Math.random() * 200) + 5,
        imageUrl: `https://picsum.photos/seed/prod${counter}/400/400`,
        sku: `SKU-${slug.slice(0, 3).toUpperCase()}-${String(counter).padStart(4, "0")}`,
        categoryId: categoryMap[slug],
      });
      counter++;
    }
  }

  await prisma.product.createMany({ data: products });

  const total = await prisma.product.count();
  console.log(`Done. ${CATEGORIES.length} categories, ${total} products in product_db.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
