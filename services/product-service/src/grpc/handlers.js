// product-service gRPC handlers. Same business logic as the old REST controllers
// (Prisma + cache-aside + audit + Kafka events) — only the transport changed:
// inputs come from typed request messages / JSON-string envelopes, outputs are
// returned (or thrown as gRPC errors) instead of written to an Express response.
const grpc = require("@grpc/grpc-js");
const prisma = require("../prisma");
const { writeAudit } = require("../audit");
const { publish } = require("../events/bus");
const { listKey, getJSON, setJSON, invalidateProductLists } = require("../cache");
const { requireAdmin, rpcError } = require("./auth");

// Wrap an async fn(call) -> { value, trailer? } into a gRPC unary handler with
// uniform error mapping. Thrown errors carrying a numeric `code` are passed
// through as gRPC status; anything else becomes INTERNAL.
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

// Shape a product row into the payload event consumers (shopping projection) expect.
function productPayload(p) {
  return { id: p.id, name: p.name, price: Number(p.price), stock: p.stock, active: p.active };
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

module.exports = {
  // GET /products?search=&category=&minPrice=&maxPrice=&page=&limit=&sort=
  List: handler(async (call) => {
    const { search, category, minPrice, maxPrice, page = "1", limit = "12", sort = "newest" } =
      JSON.parse(call.request.query || "{}");

    const take = Math.min(Number(limit) || 12, 200);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

    const where = { active: true };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
      ];
    }
    if (category) where.category = { slug: category };
    if (minPrice || maxPrice) {
      where.price = {};
      if (minPrice) where.price.gte = Number(minPrice);
      if (maxPrice) where.price.lte = Number(maxPrice);
    }

    const orderBy =
      sort === "price_asc" ? { price: "asc" } : sort === "price_desc" ? { price: "desc" } : { createdAt: "desc" };

    const key = await listKey({
      search: search || "", category: category || "", minPrice: minPrice || "", maxPrice: maxPrice || "", sort, skip, take,
    });
    const cached = await getJSON(key);
    if (cached) return { value: reply(cached), trailer: cacheTrailer("HIT") };

    const [total, products] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({ where, orderBy, skip, take, include: { category: true } }),
    ]);

    const result = {
      data: products,
      pagination: { total, page: Number(page), limit: take, pages: Math.ceil(total / take) },
    };
    await setJSON(key, result);
    return { value: reply(result), trailer: cacheTrailer("MISS") };
  }),

  Get: handler(async (call) => {
    const id = Number(call.request.id);
    const product = await prisma.product.findUnique({ where: { id }, include: { category: true } });
    if (!product) throw rpcError(grpc.status.NOT_FOUND, "Product not found");
    return { value: reply(product) };
  }),

  // GET /products/admin — admin-only listing that includes inactive products.
  AdminList: handler(async (call) => {
    requireAdmin(call);
    const { search, page = "1", limit = "200" } = JSON.parse(call.request.query || "{}");
    const take = Math.min(Number(limit) || 200, 200);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

    const key = await listKey({ admin: true, search: search || "", skip, take });
    const cached = await getJSON(key);
    if (cached) return { value: reply(cached), trailer: cacheTrailer("HIT") };

    const where = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { sku: { contains: search, mode: "insensitive" } },
      ];
    }

    const [total, products] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({ where, orderBy: { createdAt: "desc" }, skip, take, include: { category: true } }),
    ]);

    const result = {
      data: products,
      pagination: { total, page: Number(page), limit: take, pages: Math.ceil(total / take) },
    };
    await setJSON(key, result);
    return { value: reply(result), trailer: cacheTrailer("MISS") };
  }),

  ListCategories: handler(async () => {
    const [categories, grouped] = await Promise.all([
      prisma.category.findMany({ orderBy: { name: "asc" } }),
      prisma.product.groupBy({ by: ["categoryId"], where: { active: true }, _count: { _all: true } }),
    ]);
    const counts = Object.fromEntries(grouped.map((g) => [g.categoryId, g._count._all]));
    return { value: reply(categories.map((c) => ({ ...c, productCount: counts[c.id] || 0 }))) };
  }),

  // GET /products/audit-logs — admin-only.
  ListAuditLogs: handler(async (call) => {
    requireAdmin(call);
    const { page = "1", limit = "50", action, actor, entityId } = JSON.parse(call.request.query || "{}");
    const take = Math.min(Number(limit) || 50, 200);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

    const where = {};
    if (action) where.action = action;
    if (actor) where.actorEmail = { contains: actor, mode: "insensitive" };
    if (entityId) where.entityId = Number(entityId);

    const [total, logs] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
    ]);
    return {
      value: reply({ data: logs, pagination: { total, page: Number(page), limit: take, pages: Math.ceil(total / take) } }),
    };
  }),

  Create: handler(async (call) => {
    const user = requireAdmin(call);
    const { name, description, price, stock, imageUrl, sku, categoryId } = JSON.parse(call.request.body || "{}");
    if (!name || !price || !categoryId) {
      throw rpcError(grpc.status.INVALID_ARGUMENT, "name, price and categoryId are required");
    }
    const product = await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          name,
          slug: slugify(name) + "-" + Date.now().toString(36),
          description: description || "",
          price,
          stock: stock ?? 0,
          imageUrl,
          sku: sku || "SKU-" + Date.now().toString(36).toUpperCase(),
          categoryId: Number(categoryId),
        },
      });
      await writeAudit(tx, { user }, { action: "CREATE", entityId: created.id, details: { after: created } });
      return created;
    });
    await invalidateProductLists();
    await publish("product.created", productPayload(product));
    return { value: reply(product) };
  }),

  Update: handler(async (call) => {
    const user = requireAdmin(call);
    const id = Number(call.request.id);
    const { name, description, price, stock, imageUrl, active, categoryId } = JSON.parse(call.request.body || "{}");
    let product;
    try {
      product = await prisma.$transaction(async (tx) => {
        const before = await tx.product.findUnique({ where: { id } });
        const updated = await tx.product.update({
          where: { id },
          data: {
            name, description, price, stock, imageUrl, active,
            categoryId: categoryId ? Number(categoryId) : undefined,
          },
        });
        await writeAudit(tx, { user }, { action: "UPDATE", entityId: id, details: { before, after: updated } });
        return updated;
      });
    } catch (err) {
      throw rpcError(grpc.status.NOT_FOUND, "Product not found");
    }
    await invalidateProductLists();
    await publish("product.updated", productPayload(product));
    return { value: reply(product) };
  }),

  Remove: handler(async (call) => {
    const user = requireAdmin(call);
    const id = Number(call.request.id);
    try {
      await prisma.$transaction(async (tx) => {
        const before = await tx.product.findUnique({ where: { id } });
        await tx.product.delete({ where: { id } });
        await writeAudit(tx, { user }, { action: "DELETE", entityId: id, details: { before } });
      });
    } catch (err) {
      throw rpcError(grpc.status.NOT_FOUND, "Product not found");
    }
    await invalidateProductLists();
    await publish("product.deleted", { productId: id });
    return { value: {} }; // Empty
  }),

  // ---- internal, TYPED contract (shopping-service) ----

  // POST /products/bulk { ids: [...] }
  BulkByIds: handler(async (call) => {
    const ids = (call.request.ids || []).map(Number);
    const products = await prisma.product.findMany({ where: { id: { in: ids } } });
    return { value: { products: products.map(productPayload) } };
  }),

  // Atomically validate availability and decrement stock for every line.
  DecrementStock: handler(async (call) => {
    const items = call.request.items || [];
    if (!items.length) throw rpcError(grpc.status.INVALID_ARGUMENT, "items are required");

    let updated;
    try {
      updated = await prisma.$transaction(async (tx) => {
        const results = [];
        for (const item of items) {
          const id = Number(item.productId);
          const qty = Number(item.quantity);
          const product = await tx.product.findUnique({ where: { id } });
          if (!product) throw { code: "NOT_FOUND", productId: id };
          if (product.stock < qty) {
            throw { code: "INSUFFICIENT", name: product.name, available: product.stock, requested: qty };
          }
          const u = await tx.product.update({ where: { id }, data: { stock: { decrement: qty } } });
          results.push({ id: u.id, stock: u.stock });
        }
        return results;
      });
    } catch (err) {
      if (err.code === "INSUFFICIENT") {
        throw rpcError(
          grpc.status.FAILED_PRECONDITION,
          `Insufficient stock for "${err.name}" (available ${err.available}, requested ${err.requested})`
        );
      }
      if (err.code === "NOT_FOUND") {
        throw rpcError(grpc.status.NOT_FOUND, `Product ${err.productId} no longer exists`);
      }
      throw err;
    }
    for (const r of updated) await publish("product.stock.changed", { productId: r.id, stock: r.stock });
    return { value: { updated } };
  }),

  // Compensation: restore stock after a failed/cancelled order.
  Restock: handler(async (call) => {
    const items = call.request.items || [];
    const updated = await prisma.$transaction(async (tx) => {
      const out = [];
      for (const item of items) {
        const u = await tx.product.update({
          where: { id: Number(item.productId) },
          data: { stock: { increment: Number(item.quantity) } },
        });
        out.push({ id: u.id, stock: u.stock });
      }
      return out;
    });
    for (const r of updated) await publish("product.stock.changed", { productId: r.id, stock: r.stock });
    return { value: { updated } };
  }),
};
