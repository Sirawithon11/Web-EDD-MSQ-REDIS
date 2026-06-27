// gRPC auth helpers — every shopping route requires a logged-in user.
const jwt = require("jsonwebtoken");
const grpc = require("@grpc/grpc-js");

function rpcError(code, message) {
  return Object.assign(new Error(message), { code });
}

function getUser(call) {
  const md = call.metadata.get("authorization");
  const header = md && md[0] ? String(md[0]) : "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (_) {
    return null;
  }
}

function requireAuth(call) {
  const user = getUser(call);
  if (!user) throw rpcError(grpc.status.UNAUTHENTICATED, "Authentication required");
  return user;
}

function requireAdmin(call) {
  const user = requireAuth(call);
  if (user.role !== "ADMIN") throw rpcError(grpc.status.PERMISSION_DENIED, "Admin access required");
  return user;
}

module.exports = { getUser, requireAuth, requireAdmin, rpcError };
