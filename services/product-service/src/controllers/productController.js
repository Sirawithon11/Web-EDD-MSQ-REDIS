const prisma = require("../prisma");

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

  const take = Math.min(Number(limit) || 12, 100);
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

async function listCategories(req, res) {
  const categories = await prisma.category.findMany({ orderBy: { name: "asc" } });
  res.json(categories);
}

async function create(req, res) {
  const { name, description, price, stock, imageUrl, sku, categoryId } = req.body;
  if (!name || !price || !categoryId) {
    return res.status(400).json({ message: "name, price and categoryId are required" });
  }
  const product = await prisma.product.create({
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
  res.status(201).json(product);
}

async function update(req, res) {
  const id = Number(req.params.id);
  const { name, description, price, stock, imageUrl, active, categoryId } = req.body;
  try {
    const product = await prisma.product.update({
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
    res.json(product);
  } catch (err) {
    res.status(404).json({ message: "Product not found" });
  }
}

async function remove(req, res) {
  const id = Number(req.params.id);
  try {
    await prisma.product.delete({ where: { id } });
    res.status(204).end();
  } catch (err) {
    res.status(404).json({ message: "Product not found" });
  }
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
  getById,
  listCategories,
  create,
  update,
  remove,
  bulkByIds,
};
