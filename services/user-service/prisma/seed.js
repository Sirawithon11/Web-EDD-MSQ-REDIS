// Seeds ~50 users (1 admin + 49 regular users) with hashed passwords.
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const FIRST = ["James", "Mary", "John", "Patricia", "Robert", "Jennifer", "Michael",
  "Linda", "David", "Elizabeth", "William", "Barbara", "Richard", "Susan", "Joseph",
  "Jessica", "Thomas", "Sarah", "Charles", "Karen", "Somchai", "Suda", "Anan", "Nicha",
  "Pim"];
const LAST = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller",
  "Davis", "Rodriguez", "Martinez", "Wong", "Chen", "Suksawat", "Phongam", "Wattana"];
const CITIES = ["Bangkok", "Chiang Mai", "Phuket", "Khon Kaen", "Pattaya", "New York",
  "London", "Tokyo", "Singapore", "Berlin"];

function pick(arr, i) {
  return arr[i % arr.length];
}

async function main() {
  console.log("Seeding users...");

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

  const users = [];
  for (let i = 1; i <= 49; i++) {
    const first = pick(FIRST, i);
    const last = pick(LAST, i * 3);
    const password = await bcrypt.hash(`password${i}`, 10);
    users.push({
      email: `user${i}@shop.dev`,
      password,
      name: `${first} ${last}`,
      role: "USER",
      phone: `+66${800000000 + i}`,
      address: `${100 + i} Main St, ${pick(CITIES, i)}`,
    });
  }
  await prisma.user.createMany({ data: users });

  const count = await prisma.user.count();
  console.log(`Done. ${count} users in user_db.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
