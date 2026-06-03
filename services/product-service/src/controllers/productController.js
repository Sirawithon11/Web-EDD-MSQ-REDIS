const prisma = require("../prisma");
const { writeAudit } = require("../audit");

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// GET /products?search=&category=&minPrice=&maxPrice=&page=&limit=&sort=
async function list(req, res) {
  const {
    search,
    category,
    minPrice,
    maxPrice,
    page = "1",
    limit = "12",
    sort = "newest",
  } = req.query;

  const take = Math.min(Number(limit) || 12, 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const where = { active: true };
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { description: { contains: search, mode: "insensitive" } },
    ];
  }
  if (category) {
    where.category = { slug: category };
  }
  if (minPrice || maxPrice) {
    where.price = {};
    if (minPrice) where.price.gte = Number(minPrice);
    if (maxPrice) where.price.lte = Number(maxPrice);
  }

  const orderBy =
    sort === "price_asc"
      ? { price: "asc" }
      : sort === "price_desc"
      ? { price: "desc" }
      : { createdAt: "desc" };

  const [total, products] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({ where, orderBy, skip, take, include: { category: true } }),
  ]);

  res.json({
    data: products,
    pagination: { total, page: Number(page), limit: take, pages: Math.ceil(total / take) },
  });
}

async function getById(req, res) {
  const id = Number(req.params.id);
  const product = await prisma.product.findUnique({
    where: { id },
    include: { category: true },
  });
  if (!product) return res.status(404).json({ message: "Product not found" });
  res.json(product);
}

// GET /products/admin  — admin-only listing that includes inactive products.
async function adminList(req, res) {
  const { search, page = "1", limit = "200" } = req.query;
  const take = Math.min(Number(limit) || 200, 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const where = {};
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { sku: { contains: search, mode: "insensitive" } },
    ];
  }

  const [total, products] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      include: { category: true },
    }),
  ]);

  res.json({
    data: products,
    pagination: { total, page: Number(page), limit: take, pages: Math.ceil(total / take) },
  });
}

// Returns categories each annotated with the count of *active* products,
// matching what the public catalog shows.
async function listCategories(req, res) {
  const [categories, grouped] = await Promise.all([
    prisma.category.findMany({ orderBy: { name: "asc" } }),
    prisma.product.groupBy({
      by: ["categoryId"],
      where: { active: true },
      _count: { _all: true },
    }),
  ]);
  const counts = Object.fromEntries(grouped.map((g) => [g.categoryId, g._count._all]));
  res.json(categories.map((c) => ({ ...c, productCount: counts[c.id] || 0 })));
}

async function create(req, res) {
  const { name, description, price, stock, imageUrl, sku, categoryId } = req.body;
  if (!name || !price || !categoryId) {
    return res.status(400).json({ message: "name, price and categoryId are required" });
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
    await writeAudit(tx, req, { action: "CREATE", entityId: created.id, details: { after: created } });
    return created;
  });
  res.status(201).json(product);
}

async function update(req, res) {
  const id = Number(req.params.id);
  const { name, description, price, stock, imageUrl, active, categoryId } = req.body;
  try {
    const product = await prisma.$transaction(async (tx) => {
      const before = await tx.product.findUnique({ where: { id } });
      const updated = await tx.product.update({
        where: { id },
        data: {
          name,
          description,
          price,
          stock,
          imageUrl,
          active,
          categoryId: categoryId ? Number(categoryId) : undefined,
        },
      });
      await writeAudit(tx, req, { action: "UPDATE", entityId: id, details: { before, after: updated } });
      return updated;
    });
    res.json(product);
  } catch (err) {
    res.status(404).json({ message: "Product not found" });
  }
}

async function remove(req, res) {
  const id = Number(req.params.id);
  try {
    await prisma.$transaction(async (tx) => {
      const before = await tx.product.findUnique({ where: { id } });
      await tx.product.delete({ where: { id } });
      await writeAudit(tx, req, { action: "DELETE", entityId: id, details: { before } });
    });
    res.status(204).end();
  } catch (err) {
    res.status(404).json({ message: "Product not found" });
  }
}

// GET /products/audit-logs  — admin-only view of the product action history.
// Filters: action (exact), actor (email contains), entityId (exact).
async function listAuditLogs(req, res) {
  const { page = "1", limit = "50", action, actor, entityId } = req.query;
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

  res.json({
    data: logs,
    pagination: { total, page: Number(page), limit: take, pages: Math.ceil(total / take) },
  });
}

// Internal endpoint used by shopping-service at checkout.
// POST /products/decrement-stock  { items: [{ productId, quantity }] }
// Atomically validates availability and decrements stock for every line.
// Returns 409 if any product lacks sufficient stock (nothing is changed).
async function decrementStock(req, res) {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ message: "items are required" });

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const results = [];
      for (const item of items) {
        const id = Number(item.productId);
        const qty = Number(item.quantity);
        const product = await tx.product.findUnique({ where: { id } });
        if (!product) throw { code: "NOT_FOUND", productId: id };
        if (product.stock < qty) {
          throw { code: "INSUFFICIENT", name: product.name, available: product.stock, requested: qty };
        }
        const u = await tx.product.update({
          where: { id },
          data: { stock: { decrement: qty } },
        });
        results.push({ id: u.id, stock: u.stock });
      }
      return results;
    });
    res.json({ updated });
  } catch (err) {
    if (err.code === "INSUFFICIENT") {
      return res.status(409).json({
        message: `Insufficient stock for "${err.name}" (available ${err.available}, requested ${err.requested})`,
      });
    }
    if (err.code === "NOT_FOUND") {
      return res.status(404).json({ message: `Product ${err.productId} no longer exists` });
    }
    throw err;
  }
}

// Internal endpoint used by shopping-service to compensate (restore stock) when
// an order fails after stock was already decremented.
// POST /products/restock  { items: [{ productId, quantity }] }
async function restock(req, res) {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  await prisma.$transaction(
    items.map((item) =>
      prisma.product.update({
        where: { id: Number(item.productId) },
        data: { stock: { increment: Number(item.quantity) } },
      })
    )
  );
  res.json({ ok: true });
}

// Internal endpoint used by shopping-service to validate / fetch products in bulk.
// POST /products/bulk  { ids: [1,2,3] }
async function bulkByIds(req, res) {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
  const products = await prisma.product.findMany({ where: { id: { in: ids } } });
  res.json(products);
}

module.exports = {
  list,
  adminList,
  listAuditLogs,
  getById,
  listCategories,
  create,
  update,
  remove,
  bulkByIds,
  decrementStock,
  restock,
};
