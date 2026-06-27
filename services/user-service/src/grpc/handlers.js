// user-service gRPC handlers. Same logic as the old REST controllers (Prisma +
// bcrypt + JWT + cache-aside + Kafka) — only the transport changed.
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const grpc = require("@grpc/grpc-js");
const prisma = require("../prisma");
const { publish } = require("../events/bus");
const { getJSON, setJSON, invalidateUsersList, USERS_LIST_KEY } = require("../cache");
const { requireAuth, requireAdmin, rpcError } = require("./auth");

function handler(fn) {
  return async (call, callback) => {
    try {
      const { value, trailer } = await fn(call);
      callback(null, value, trailer);
    } catch (err) {
      if (typeof err.code === "number") return callback({ code: err.code, message: err.message });
      console.error(err);
      callback({ code: grpc.status.INTERNAL, message: "Internal server error" });
    }
  };
}

const reply = (obj) => ({ json: JSON.stringify(obj) });
const cacheTrailer = (status) => {
  const t = new grpc.Metadata();
  t.set("x-cache", status);
  return t;
};

function sign(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "1d" }
  );
}

function publicUser(user) {
  const { password, ...rest } = user;
  return rest;
}

module.exports = {
  Register: handler(async (call) => {
    const { email, password, name, phone, address } = JSON.parse(call.request.body || "{}");
    if (!email || !password || !name) {
      throw rpcError(grpc.status.INVALID_ARGUMENT, "email, password and name are required");
    }
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw rpcError(grpc.status.ALREADY_EXISTS, "Email already registered");

    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({ data: { email, password: hashed, name, phone, address } });

    await invalidateUsersList();
    await publish("user.registered", { userId: user.id, email: user.email, name: user.name });
    return { value: reply({ token: sign(user), user: publicUser(user) }) };
  }),

  Login: handler(async (call) => {
    const { email, password } = JSON.parse(call.request.body || "{}");
    if (!email || !password) {
      throw rpcError(grpc.status.INVALID_ARGUMENT, "email and password are required");
    }
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      throw rpcError(grpc.status.UNAUTHENTICATED, "Invalid credentials");
    }
    return { value: reply({ token: sign(user), user: publicUser(user) }) };
  }),

  Me: handler(async (call) => {
    const auth = requireAuth(call);
    const user = await prisma.user.findUnique({ where: { id: auth.id } });
    if (!user) throw rpcError(grpc.status.NOT_FOUND, "User not found");
    return { value: reply(publicUser(user)) };
  }),

  // GET /users — admin-only. Cache-aside with event-driven invalidation.
  List: handler(async (call) => {
    requireAdmin(call);
    const cached = await getJSON(USERS_LIST_KEY);
    if (cached) return { value: reply(cached), trailer: cacheTrailer("HIT") };

    const users = await prisma.user.findMany({ orderBy: { id: "asc" } });
    const payload = users.map(publicUser);
    await setJSON(USERS_LIST_KEY, payload);
    return { value: reply(payload), trailer: cacheTrailer("MISS") };
  }),

  GetById: handler(async (call) => {
    requireAdmin(call);
    const user = await prisma.user.findUnique({ where: { id: Number(call.request.id) } });
    if (!user) throw rpcError(grpc.status.NOT_FOUND, "User not found");
    return { value: reply(publicUser(user)) };
  }),

  GetByEmail: handler(async (call) => {
    requireAdmin(call);
    const email = call.request.email;
    if (!email) throw rpcError(grpc.status.INVALID_ARGUMENT, "email is required");
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw rpcError(grpc.status.NOT_FOUND, "User not found");
    return { value: reply(publicUser(user)) };
  }),
};
