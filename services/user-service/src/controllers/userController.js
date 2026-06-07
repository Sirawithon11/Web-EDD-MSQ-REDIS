const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const prisma = require("../prisma");
const { publish } = require("../events/bus");
const { getJSON, setJSON, invalidateUsersList, USERS_LIST_KEY } = require("../cache");

function sign(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "1d" }
  );
}

// strip the password before returning a user
function publicUser(user) {
  const { password, ...rest } = user;
  return rest;
}

async function register(req, res) {
  const { email, password, name, phone, address } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ message: "email, password and name are required" });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return res.status(409).json({ message: "Email already registered" });
  }

  const hashed = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { email, password: hashed, name, phone, address },
  });

  // A new user changes the list membership — bust the cache immediately so the
  // admin list reflects the registration (read-your-writes on the local write).
  await invalidateUsersList();

  // Publish AFTER the row is committed (pure broker — no transactional outbox).
  await publish("user.registered", {
    userId: user.id,
    email: user.email,
    name: user.name,
  });

  return res.status(201).json({ token: sign(user), user: publicUser(user) });
}

async function login(req, res) {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: "email and password are required" });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ message: "Invalid credentials" });
  }

  return res.json({ token: sign(user), user: publicUser(user) });
}

async function me(req, res) {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) return res.status(404).json({ message: "User not found" });
  return res.json(publicUser(user));
}

// GET /users — admin-only. Cache-aside: serve from Redis if present, otherwise
// read Postgres and populate the cache. The cache is kept correct not by a TTL
// alone but by event-driven invalidation (see invalidateUsersList callers).
async function list(req, res) {
  const cached = await getJSON(USERS_LIST_KEY);
  if (cached) {
    res.setHeader("X-Cache", "HIT");
    return res.json(cached);
  }

  const users = await prisma.user.findMany({ orderBy: { id: "asc" } });
  const payload = users.map(publicUser);
  await setJSON(USERS_LIST_KEY, payload);
  res.setHeader("X-Cache", "MISS");
  return res.json(payload);
}

async function getById(req, res) {
  const id = Number(req.params.id);
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) return res.status(404).json({ message: "User not found" });
  return res.json(publicUser(user));
}

// GET /users/by-email?email=...  — admin-only. Looks a user up by email, which
// is served by the `email @unique` index (a point lookup, not a table scan) —
// the read counterpart to login/register's existence check.
async function getByEmail(req, res) {
  const email = req.query.email;
  if (!email) return res.status(400).json({ message: "email query param is required" });
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(404).json({ message: "User not found" });
  return res.json(publicUser(user));
}

module.exports = { register, login, me, list, getById, getByEmail };
