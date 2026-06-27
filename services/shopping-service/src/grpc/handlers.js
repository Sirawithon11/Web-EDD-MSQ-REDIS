// shopping-service gRPC handlers — cart, orders (checkout saga) and analytics.
// Same business logic as the old REST controllers (Prisma + the product gRPC
// client + audit + Kafka). All routes require a logged-in user (requireAuth);
// admin-only ones use requireAdmin.
const grpc = require("@grpc/grpc-js");
const prisma = require("../prisma");
const { getProductsByIds, decrementStock, restock } = require("../productClient");
const { getProductViews } = require("../productView");
const { writeAudit } = require("../audit");
const { publish } = require("../events/bus");
const { requireAuth, requireAdmin, rpcError } = require("./auth");

function handler(fn) {
  return async (call, callback) => {
    try {
      const value = await fn(call);
      callback(null, value);
    } catch (err) {
      if (typeof err.code === "number") return callback({ code: err.code, message: err.message });
      console.error(err);
      callback({ code: grpc.status.INTERNAL, message: "Internal server error" });
    }
  };
}

const reply = (obj) => ({ json: JSON.stringify(obj) });

// order.* events carry the line items so consumers (user stats, product
// salesCount) can attribute quantities without a callback.
const eventItems = (items) => items.map((i) => ({ productId: i.productId, quantity: i.quantity }));

// JSON can't serialize BigInt (Postgres COUNT/SUM come back as BigInt).
function num(v) {
  if (v === null || v === undefined) return 0;
  return typeof v === "bigint" ? Number(v) : Number(v);
}

// ----------------------------- cart helpers -----------------------------
async function getOrCreateCart(userId) {
  let cart = await prisma.cart.findUnique({ where: { userId }, include: { items: true } });
  if (!cart) cart = await prisma.cart.create({ data: { userId }, include: { items: true } });
  return cart;
}

// Enrich cart items with live product data (name, price, image) from product-service.
async function enrichCart(cart) {
  const ids = cart.items.map((i) => i.productId);
  const products = await getProductsByIds(ids);
  const byId = Object.fromEntries(products.map((p) => [p.id, p]));

  const items = cart.items.map((item) => {
    const product = byId[item.productId] || null;
    const price = product ? Number(product.price) : 0;
    return {
      id: item.id,
      productId: item.productId,
      quantity: item.quantity,
      product,
      lineTotal: Number((price * item.quantity).toFixed(2)),
    };
  });

  const subtotal = items.reduce((sum, i) => sum + i.lineTotal, 0);
  return {
    id: cart.id,
    userId: cart.userId,
    items,
    subtotal: Number(subtotal.toFixed(2)),
    itemCount: items.reduce((n, i) => n + i.quantity, 0),
  };
}

const REVENUE_STATUSES = ["PAID", "SHIPPED", "DELIVERED"];

module.exports = {
  // ------------------------------- cart -------------------------------
  GetCart: handler(async (call) => {
    const user = requireAuth(call);
    const cart = await getOrCreateCart(user.id);
    return reply(await enrichCart(cart));
  }),

  AddItem: handler(async (call) => {
    const user = requireAuth(call);
    const { productId, quantity = 1 } = JSON.parse(call.request.body || "{}");
    if (!productId) throw rpcError(grpc.status.INVALID_ARGUMENT, "productId is required");

    const products = await getProductsByIds([Number(productId)]);
    if (!products.length) throw rpcError(grpc.status.NOT_FOUND, "Product not found");

    const cart = await getOrCreateCart(user.id);
    await prisma.cartItem.upsert({
      where: { cartId_productId: { cartId: cart.id, productId: Number(productId) } },
      update: { quantity: { increment: Number(quantity) } },
      create: { cartId: cart.id, productId: Number(productId), quantity: Number(quantity) },
    });

    const refreshed = await prisma.cart.findUnique({ where: { id: cart.id }, include: { items: true } });
    return reply(await enrichCart(refreshed));
  }),

  UpdateItem: handler(async (call) => {
    const user = requireAuth(call);
    const itemId = Number(call.request.itemId);
    const { quantity } = JSON.parse(call.request.body || "{}");
    if (quantity == null || Number(quantity) < 1) {
      throw rpcError(grpc.status.INVALID_ARGUMENT, "quantity must be >= 1");
    }
    const cart = await getOrCreateCart(user.id);
    const item = await prisma.cartItem.findFirst({ where: { id: itemId, cartId: cart.id } });
    if (!item) throw rpcError(grpc.status.NOT_FOUND, "Cart item not found");

    await prisma.cartItem.update({ where: { id: itemId }, data: { quantity: Number(quantity) } });
    const refreshed = await prisma.cart.findUnique({ where: { id: cart.id }, include: { items: true } });
    return reply(await enrichCart(refreshed));
  }),

  RemoveItem: handler(async (call) => {
    const user = requireAuth(call);
    const itemId = Number(call.request.itemId);
    const cart = await getOrCreateCart(user.id);
    const item = await prisma.cartItem.findFirst({ where: { id: itemId, cartId: cart.id } });
    if (!item) throw rpcError(grpc.status.NOT_FOUND, "Cart item not found");

    await prisma.cartItem.delete({ where: { id: itemId } });
    const refreshed = await prisma.cart.findUnique({ where: { id: cart.id }, include: { items: true } });
    return reply(await enrichCart(refreshed));
  }),

  // ------------------------------ orders ------------------------------
  // POST /orders — turn the current user's cart into an order, then clear it.
  Checkout: handler(async (call) => {
    const user = requireAuth(call);
    const userId = user.id;

    const cart = await prisma.cart.findUnique({ where: { userId }, include: { items: true } });
    if (!cart || cart.items.length === 0) throw rpcError(grpc.status.INVALID_ARGUMENT, "Cart is empty");

    const ids = cart.items.map((i) => i.productId);
    const products = await getProductsByIds(ids);
    const byId = Object.fromEntries(products.map((p) => [p.id, p]));

    let total = 0;
    const orderItems = cart.items.map((item) => {
      const product = byId[item.productId];
      const price = product ? Number(product.price) : 0;
      total += price * item.quantity;
      return {
        productId: item.productId,
        productName: product ? product.name : `Product #${item.productId}`,
        price,
        quantity: item.quantity,
      };
    });

    // Reserve stock in product-service first (strongly-consistent saga step).
    const stockItems = cart.items.map((i) => ({ productId: i.productId, quantity: i.quantity }));
    try {
      await decrementStock(stockItems);
    } catch (err) {
      // 409 insufficient / 404 gone map straight through; anything else -> UNAVAILABLE.
      const code =
        err.status === 409
          ? grpc.status.FAILED_PRECONDITION
          : err.status === 404
          ? grpc.status.NOT_FOUND
          : grpc.status.UNAVAILABLE;
      throw rpcError(code, err.message);
    }

    let order;
    try {
      order = await prisma.$transaction(async (tx) => {
        const created = await tx.order.create({
          data: { userId, status: "PENDING", total: Number(total.toFixed(2)), items: { create: orderItems } },
          include: { items: true },
        });
        await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
        await writeAudit(tx, { user }, {
          action: "PLACE_ORDER",
          entityId: created.id,
          details: { total: created.total, itemCount: orderItems.length },
        });
        return created;
      });
    } catch (err) {
      // Order failed after stock was decremented — compensate (saga rollback).
      await restock(stockItems);
      throw err;
    }

    await publish("order.placed", {
      orderId: order.id,
      userId,
      total: Number(order.total),
      items: eventItems(order.items),
    });
    return reply(order);
  }),

  ListOrders: handler(async (call) => {
    const user = requireAuth(call);
    const orders = await prisma.order.findMany({
      where: { userId: user.id },
      include: { items: true },
      orderBy: { createdAt: "desc" },
    });
    return reply(orders);
  }),

  GetOrder: handler(async (call) => {
    const user = requireAuth(call);
    const id = Number(call.request.id);
    if (!Number.isInteger(id)) throw rpcError(grpc.status.INVALID_ARGUMENT, "Invalid order id");
    const order = await prisma.order.findFirst({ where: { id, userId: user.id }, include: { items: true } });
    if (!order) throw rpcError(grpc.status.NOT_FOUND, "Order not found");
    return reply(order);
  }),

  // DELETE /orders/:id — a user may delete their OWN order; an admin may delete ANY.
  DeleteOrder: handler(async (call) => {
    const user = requireAuth(call);
    const id = Number(call.request.id);
    if (!Number.isInteger(id)) throw rpcError(grpc.status.INVALID_ARGUMENT, "Invalid order id");
    const isAdmin = user.role === "ADMIN";

    const order = await prisma.order.findFirst({
      where: isAdmin ? { id } : { id, userId: user.id },
      include: { items: true },
    });
    if (!order) throw rpcError(grpc.status.NOT_FOUND, "Order not found");

    await prisma.$transaction(async (tx) => {
      await tx.order.delete({ where: { id } });
      await writeAudit(tx, { user }, {
        action: "DELETE_ORDER",
        entityId: id,
        details: {
          status: order.status,
          total: order.total,
          itemCount: order.items.length,
          ownerUserId: order.userId,
          byRole: user.role,
        },
      });
    });

    await publish("order.deleted", {
      orderId: id,
      userId: order.userId,
      total: Number(order.total),
      status: order.status,
      items: eventItems(order.items),
    });

    if (order.status !== "CANCELLED") {
      await restock(order.items.map((i) => ({ productId: i.productId, quantity: i.quantity })));
    }
    return {}; // Empty
  }),

  // PATCH /orders/:id/status — admin-only.
  UpdateStatus: handler(async (call) => {
    const user = requireAdmin(call);
    const id = Number(call.request.id);
    if (!Number.isInteger(id)) throw rpcError(grpc.status.INVALID_ARGUMENT, "Invalid order id");
    const { status } = JSON.parse(call.request.body || "{}");
    const valid = ["PENDING", "PAID", "SHIPPED", "DELIVERED", "CANCELLED"];
    if (!valid.includes(status)) throw rpcError(grpc.status.INVALID_ARGUMENT, "Invalid status");

    const order = await prisma.order.findUnique({ where: { id }, include: { items: true } });
    if (!order) throw rpcError(grpc.status.NOT_FOUND, "Order not found");

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.order.update({ where: { id }, data: { status }, include: { items: true } });
      await writeAudit(tx, { user }, { action: "UPDATE_STATUS", entityId: id, details: { from: order.status, to: status } });
      return result;
    });

    await publish("order.status.changed", {
      orderId: id,
      userId: order.userId,
      total: Number(order.total),
      from: order.status,
      to: status,
      items: eventItems(order.items),
    });

    if (status === "CANCELLED" && order.status !== "CANCELLED") {
      await restock(order.items.map((i) => ({ productId: i.productId, quantity: i.quantity })));
    }
    return reply(updated);
  }),

  // GET /orders/all — admin-only listing of every order.
  AdminListOrders: handler(async (call) => {
    requireAdmin(call);
    const { page = "1", limit = "50" } = JSON.parse(call.request.query || "{}");
    const take = Math.min(Number(limit) || 50, 200);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

    const [total, orders] = await Promise.all([
      prisma.order.count(),
      prisma.order.findMany({ include: { items: true }, orderBy: { createdAt: "desc" }, skip, take }),
    ]);
    return reply({ data: orders, pagination: { total, page: Number(page), limit: take, pages: Math.ceil(total / take) } });
  }),

  // GET /orders/audit-logs — admin-only.
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
    return reply({ data: logs, pagination: { total, page: Number(page), limit: take, pages: Math.ceil(total / take) } });
  }),

  // ----------------------------- analytics -----------------------------
  // GET /orders/analytics/sales — admin-only. Heavy roll-up + product enrichment.
  SalesReport: handler(async (call) => {
    requireAdmin(call);
    const { from: fromQ, to: toQ, limit: limitQ } = JSON.parse(call.request.query || "{}");
    const now = new Date();
    const from = fromQ ? new Date(fromQ) : new Date(now.getTime() - 30 * 864e5);
    const to = toQ ? new Date(toQ) : now;
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw rpcError(grpc.status.INVALID_ARGUMENT, "Invalid from/to date");
    }
    if (from >= to) throw rpcError(grpc.status.INVALID_ARGUMENT, "`from` must be before `to`");
    const limit = Math.min(Math.max(Number(limitQ) || 10, 1), 50);

    const startedAt = Date.now();
    try {
      const [[summary], topProducts, daily, byStatus] = await Promise.all([
        prisma.$queryRaw`
          SELECT
            COUNT(DISTINCT o.id)                              AS order_count,
            COALESCE(SUM(oi.price * oi.quantity), 0)          AS revenue,
            COALESCE(SUM(oi.quantity), 0)                     AS units_sold,
            COUNT(DISTINCT o."userId")                        AS customer_count
          FROM orders o
          JOIN order_items oi ON oi."orderId" = o.id
          WHERE o.status::text = ANY (${REVENUE_STATUSES})
            AND o."createdAt" >= ${from}
            AND o."createdAt" <  ${to}
        `,
        prisma.$queryRaw`
          SELECT
            oi."productId"                            AS product_id,
            MAX(oi."productName")                     AS product_name,
            SUM(oi.quantity)                          AS units_sold,
            SUM(oi.price * oi.quantity)               AS revenue,
            COUNT(DISTINCT o.id)                      AS order_count
          FROM order_items oi
          JOIN orders o ON o.id = oi."orderId"
          WHERE o.status::text = ANY (${REVENUE_STATUSES})
            AND o."createdAt" >= ${from}
            AND o."createdAt" <  ${to}
          GROUP BY oi."productId"
          ORDER BY revenue DESC
          LIMIT ${limit}
        `,
        prisma.$queryRaw`
          SELECT
            date_trunc('day', o."createdAt")          AS day,
            COUNT(DISTINCT o.id)                      AS order_count,
            SUM(oi.price * oi.quantity)               AS revenue
          FROM orders o
          JOIN order_items oi ON oi."orderId" = o.id
          WHERE o.status::text = ANY (${REVENUE_STATUSES})
            AND o."createdAt" >= ${from}
            AND o."createdAt" <  ${to}
          GROUP BY day
          ORDER BY day ASC
        `,
        prisma.$queryRaw`
          SELECT
            o.status::text                            AS status,
            COUNT(DISTINCT o.id)                      AS order_count,
            COALESCE(SUM(oi.price * oi.quantity), 0)  AS revenue
          FROM orders o
          LEFT JOIN order_items oi ON oi."orderId" = o.id
          WHERE o."createdAt" >= ${from}
            AND o."createdAt" <  ${to}
          GROUP BY o.status
          ORDER BY revenue DESC
        `,
      ]);

      let catalogue = {};
      try {
        const products = await getProductViews(topProducts.map((r) => Number(r.product_id)));
        catalogue = Object.fromEntries(products.map((p) => [p.id, p]));
      } catch (_) {
        /* best-effort */
      }

      const orderCount = num(summary?.order_count);
      const revenue = num(summary?.revenue);

      return reply({
        range: { from, to },
        summary: {
          orderCount,
          revenue: Number(revenue.toFixed(2)),
          unitsSold: num(summary?.units_sold),
          customerCount: num(summary?.customer_count),
          averageOrderValue: orderCount ? Number((revenue / orderCount).toFixed(2)) : 0,
        },
        topProducts: topProducts.map((r) => {
          const live = catalogue[Number(r.product_id)];
          return {
            productId: num(r.product_id),
            name: r.product_name,
            unitsSold: num(r.units_sold),
            revenue: Number(num(r.revenue).toFixed(2)),
            orderCount: num(r.order_count),
            currentStock: live?.stock,
            currentPrice: live ? Number(live.price) : undefined,
            active: live?.active,
          };
        }),
        dailyRevenue: daily.map((r) => ({
          day: r.day,
          orderCount: num(r.order_count),
          revenue: Number(num(r.revenue).toFixed(2)),
        })),
        byStatus: byStatus.map((r) => ({
          status: r.status,
          orderCount: num(r.order_count),
          revenue: Number(num(r.revenue).toFixed(2)),
        })),
        meta: { generatedInMs: Date.now() - startedAt },
      });
    } catch (err) {
      if (typeof err.code === "number") throw err; // already a gRPC error
      console.error("salesReport failed:", err);
      throw rpcError(grpc.status.INTERNAL, err?.meta?.message || err.message || "Analytics report failed");
    }
  }),

  // GET /orders/analytics/affinity — admin-only. Market-basket co-purchase analysis.
  ProductAffinity: handler(async (call) => {
    requireAdmin(call);
    const { from: fromQ, to: toQ, limit: limitQ } = JSON.parse(call.request.query || "{}");
    const now = new Date();
    const from = fromQ ? new Date(fromQ) : new Date(now.getTime() - 90 * 864e5);
    const to = toQ ? new Date(toQ) : now;
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw rpcError(grpc.status.INVALID_ARGUMENT, "Invalid from/to date");
    }
    if (from >= to) throw rpcError(grpc.status.INVALID_ARGUMENT, "`from` must be before `to`");
    const limit = Math.min(Math.max(Number(limitQ) || 20, 1), 100);

    const startedAt = Date.now();
    try {
      const pairs = await prisma.$queryRaw`
        SELECT
          a."productId"               AS product_a,
          MAX(a."productName")        AS name_a,
          b."productId"               AS product_b,
          MAX(b."productName")        AS name_b,
          COUNT(*)                    AS co_count,
          COUNT(DISTINCT a."orderId") AS order_count,
          SUM(a.price * a.quantity + b.price * b.quantity) AS pair_revenue
        FROM order_items a
        JOIN order_items b
          ON b."orderId" = a."orderId"
         AND a."productId" < b."productId"
        JOIN orders o ON o.id = a."orderId"
        WHERE o.status::text = ANY (${REVENUE_STATUSES})
          AND o."createdAt" >= ${from}
          AND o."createdAt" <  ${to}
        GROUP BY a."productId", b."productId"
        ORDER BY co_count DESC
        LIMIT ${limit}
      `;

      let catalogue = {};
      try {
        const ids = [...new Set(pairs.flatMap((r) => [Number(r.product_a), Number(r.product_b)]))];
        const products = await getProductViews(ids);
        catalogue = Object.fromEntries(products.map((p) => [p.id, p]));
      } catch (_) {
        /* best-effort */
      }

      const side = (id, name) => {
        const live = catalogue[Number(id)];
        return {
          productId: num(id),
          name: live?.name ?? name,
          currentStock: live?.stock,
          currentPrice: live ? Number(live.price) : undefined,
          active: live?.active,
        };
      };

      return reply({
        range: { from, to },
        pairs: pairs.map((r) => ({
          a: side(r.product_a, r.name_a),
          b: side(r.product_b, r.name_b),
          coCount: num(r.co_count),
          orderCount: num(r.order_count),
          pairRevenue: Number(num(r.pair_revenue).toFixed(2)),
        })),
        meta: { generatedInMs: Date.now() - startedAt },
      });
    } catch (err) {
      if (typeof err.code === "number") throw err;
      console.error("productAffinity failed:", err);
      throw rpcError(grpc.status.INTERNAL, err?.meta?.message || err.message || "Affinity report failed");
    }
  }),
};
