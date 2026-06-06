const prisma = require("../prisma");
const { getProductsByIds } = require("../productClient");

// Statuses that count as real revenue (a placed-but-cancelled order earns nothing).
const REVENUE_STATUSES = ["PAID", "SHIPPED", "DELIVERED"];

// JSON can't serialize BigInt (Postgres COUNT/SUM come back as BigInt). Coerce
// the aggregate rows into plain numbers before they leave the controller.
function num(v) {
  if (v === null || v === undefined) return 0;
  return typeof v === "bigint" ? Number(v) : Number(v);
}

// GET /orders/analytics/sales  — admin-only.
//
// This is intentionally a "hard" query: it scans every order + order_item in
// the requested window (hundreds of thousands of rows in the seeded dataset),
// rolls them up four different ways, and then reaches across to product-service
// to enrich the best sellers with live catalogue data. It is deliberately the
// slow, un-optimised baseline — the thing later turned async / cached / event
// driven once the latency hurts.
//
// Query params:
//   from   ISO date (inclusive)   default: 30 days ago
//   to     ISO date (exclusive)   default: now
//   limit  top-N products         default: 10, max 50
async function salesReport(req, res) {
  const now = new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(now.getTime() - 30 * 864e5);
  const to = req.query.to ? new Date(req.query.to) : now;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return res.status(400).json({ message: "Invalid from/to date" });
  }
  if (from >= to) {
    return res.status(400).json({ message: "`from` must be before `to`" });
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);

  const startedAt = Date.now();

  try {
  // Run the four heavy roll-ups concurrently. Each one independently joins
  // orders -> order_items across the whole window; together they are the bulk
  // of the request's cost.
  const [[summary], topProducts, daily, byStatus] = await Promise.all([
    // 1) headline totals
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

    // 2) best sellers by revenue
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

    // 3) revenue time-series, one row per day
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

    // 4) order count + revenue split by status (all statuses, not just revenue)
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

  // Enrich the best sellers with live catalogue data from product-service.
  // Cross-service hop — another reason this endpoint is a latency hotspot.
  let catalogue = {};
  try {
    const products = await getProductsByIds(topProducts.map((r) => Number(r.product_id)));
    catalogue = Object.fromEntries(products.map((p) => [p.id, p]));
  } catch (_) {
    /* best-effort: fall back to the snapshot name stored on the order item */
  }

  const orderCount = num(summary?.order_count);
  const revenue = num(summary?.revenue);

  res.json({
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
        // live fields are undefined if product-service was unreachable
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
    // Surface the failure as a real 500 (with the Postgres message when present)
    // instead of letting the async throw reset the socket — that bubbles up to
    // the gateway as an opaque 504.
    console.error("salesReport failed:", err);
    res.status(500).json({
      message: "Analytics report failed",
      detail: err?.meta?.message || err.message,
    });
  }
}

module.exports = { salesReport };
