// Seeds an enterprise-scale set of users (1 admin + N regular users).
//
// Scale is env-overridable:
//   SEED_USERS         number of regular users   (default 100000)
//   SEED_USER_PASSWORD shared password for them  (default "password123")
//
// Performance notes:
//   - bcrypt is hashed ONCE for a shared password and reused. Hashing every
//     user individually (cost 10 ≈ 50-100ms) would take hours at this scale.
//   - rows are inserted with batched createMany (one multi-row INSERT per batch).
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const NUM_USERS = Number(process.env.SEED_USERS || 100000);
const SHARED_PASSWORD = process.env.SEED_USER_PASSWORD || "password123";
const BATCH = 5000; // well under Postgres' 65535-parameter-per-statement limit

const FIRST = ["James", "Mary", "John", "Patricia", "Robert", "Jennifer", "Michael",
  "Linda", "David", "Elizabeth", "William", "Barbara", "Richard", "Susan", "Joseph",
  "Jessica", "Thomas", "Sarah", "Charles", "Karen", "Somchai", "Suda", "Anan", "Nicha",
  "Pim", "Daniel", "Laura", "Mark", "Emily", "Paul", "Olivia", "Kevin", "Grace"];
const LAST = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller",
  "Davis", "Rodriguez", "Martinez", "Wong", "Chen", "Suksawat", "Phongam", "Wattana",
  "Lee", "Walker", "Hall", "Young", "King", "Wright", "Hill", "Green", "Adams"];
const CITIES = ["Bangkok", "Chiang Mai", "Phuket", "Khon Kaen", "Pattaya", "New York",
  "London", "Tokyo", "Singapore", "Berlin", "Sydney", "Toronto", "Paris", "Dubai"];

function pick(arr, i) {
  return arr[i % arr.length];
}

async function main() {
  console.log(`Seeding ${NUM_USERS.toLocaleString()} users...`);

  await prisma.user.deleteMany();

  const adminPassword = await bcrypt.hash("admin123", 10);
  await prisma.user.create({
    data: {
      email: "admin@shop.dev",
      password: adminPassword,
      name: "Site Admin",
      role: "ADMIN",
      phone: "+66800000000",
      address: "HQ, Bangkok",
    },
  });

  // Hash the shared password exactly once, then reuse the hash for every user.
  const sharedHash = await bcrypt.hash(SHARED_PASSWORD, 10);

  let buffer = [];
  let created = 0;
  for (let i = 1; i <= NUM_USERS; i++) {
    const first = pick(FIRST, i);
    const last = pick(LAST, i * 3);
    buffer.push({
      email: `user${i}@shop.dev`,
      password: sharedHash,
      name: `${first} ${last}`,
      role: "USER",
      phone: `+66${800000000 + i}`,
      address: `${100 + i} Main St, ${pick(CITIES, i)}`,
    });

    if (buffer.length >= BATCH) {
      await prisma.user.createMany({ data: buffer });
      created += buffer.length;
      buffer = [];
      console.log(`  ...${created.toLocaleString()}/${NUM_USERS.toLocaleString()}`);
    }
  }
  if (buffer.length) {
    await prisma.user.createMany({ data: buffer });
    created += buffer.length;
  }

  const count = await prisma.user.count();
  console.log(`Done. ${count.toLocaleString()} users in user_db (1 admin).`);
  console.log(`Logins: admin@shop.dev / admin123  |  userN@shop.dev / ${SHARED_PASSWORD}  (N = 1..${NUM_USERS})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
