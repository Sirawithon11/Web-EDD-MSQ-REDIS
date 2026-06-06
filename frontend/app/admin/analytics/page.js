"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";

const STATUS_COLORS = {
  PENDING: "#b45309",
  PAID: "#2563eb",
  SHIPPED: "#7c3aed",
  DELIVERED: "#16a34a",
  CANCELLED: "#dc2626",
};

// YYYY-MM-DD for <input type="date">
function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

const money = (n) =>
  `$${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const count = (n) => Number(n || 0).toLocaleString();

function StatCard({ label, value, hint }) {
  return (
    <div className="card" style={{ padding: 16, gap: 4 }}>
      <span className="muted">{label}</span>
      <strong style={{ fontSize: 24 }}>{value}</strong>
      {hint && <span className="muted">{hint}</span>}
    </div>
  );
}

export default function AdminAnalyticsPage() {
  const { user, loading: authLoading } = useAuth();
  const isAdmin = user?.role === "ADMIN";

  const today = new Date();
  const monthAgo = new Date(today.getTime() - 30 * 864e5);
  const [from, setFrom] = useState(isoDay(monthAgo));
  const [to, setTo] = useState(isoDay(today));
  const [limit, setLimit] = useState(10);

  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ from, to, limit: String(limit) });
    api
      .salesReport(`?${params.toString()}`)
      .then(setReport)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [from, to, limit]);

  useEffect(() => {
    if (!isAdmin) return;
    load();
  }, [isAdmin, load]);

  if (authLoading) return <p className="muted">Loading…</p>;
  if (!isAdmin) return <p className="error">Admin access required.</p>;

  const maxDaily = report ? Math.max(1, ...report.dailyRevenue.map((d) => d.revenue)) : 1;
  const maxTop = report ? Math.max(1, ...report.topProducts.map((p) => p.revenue)) : 1;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ marginBottom: 0 }}>Sales analytics</h1>
        {report && (
          <span
            className="badge"
            title="Server-side time to compute this report"
            style={{ background: "transparent", border: "1px solid var(--border)", color: "var(--muted)" }}
          >
            ⏱ {count(report.meta.generatedInMs)} ms
          </span>
        )}
      </div>

      <div className="toolbar" style={{ marginTop: 16 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          From
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          To
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          Top products
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {[5, 10, 20, 50].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn" onClick={load} disabled={loading} style={{ alignSelf: "flex-end" }}>
          {loading ? "Running…" : "Run report"}
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {loading && !report ? (
        <p className="muted">Crunching orders…</p>
      ) : !report ? null : (
        <>
          {/* Headline numbers */}
          <div
            className="grid"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", marginBottom: 24 }}
          >
            <StatCard label="Revenue" value={money(report.summary.revenue)} />
            <StatCard label="Orders" value={count(report.summary.orderCount)} />
            <StatCard label="Units sold" value={count(report.summary.unitsSold)} />
            <StatCard label="Customers" value={count(report.summary.customerCount)} />
            <StatCard label="Avg order value" value={money(report.summary.averageOrderValue)} />
          </div>

          {/* Daily revenue bar chart (pure CSS) */}
          <h2 style={{ fontSize: 18 }}>Daily revenue</h2>
          {report.dailyRevenue.length === 0 ? (
            <p className="muted">No revenue in this range.</p>
          ) : (
            <div
              className="card"
              style={{
                padding: 16,
                marginBottom: 24,
                display: "flex",
                alignItems: "flex-end",
                gap: 4,
                height: 200,
                overflowX: "auto",
              }}
            >
              {report.dailyRevenue.map((d) => (
                <div
                  key={d.day}
                  title={`${new Date(d.day).toLocaleDateString()} · ${money(d.revenue)} · ${count(d.orderCount)} orders`}
                  style={{ flex: "1 0 8px", display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%" }}
                >
                  <div
                    style={{
                      height: `${(d.revenue / maxDaily) * 100}%`,
                      background: "var(--primary)",
                      borderRadius: "4px 4px 0 0",
                      minHeight: 2,
                    }}
                  />
                </div>
              ))}
            </div>
          )}

          {/* Top products */}
          <h2 style={{ fontSize: 18 }}>Top products by revenue</h2>
          {report.topProducts.length === 0 ? (
            <p className="muted">No sales in this range.</p>
          ) : (
            <div style={{ marginBottom: 24 }}>
              {report.topProducts.map((p, i) => (
                <div className="row" key={p.productId}>
                  <span className="muted" style={{ width: 24, textAlign: "right" }}>
                    {i + 1}
                  </span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {p.name}
                    </div>
                    <div
                      style={{
                        height: 6,
                        marginTop: 4,
                        background: "var(--bg)",
                        borderRadius: 999,
                        overflow: "hidden",
                      }}
                    >
                      <div style={{ width: `${(p.revenue / maxTop) * 100}%`, height: "100%", background: "var(--primary)" }} />
                    </div>
                    <div className="muted" style={{ marginTop: 4 }}>
                      {count(p.unitsSold)} sold · {count(p.orderCount)} orders
                      {p.currentStock !== undefined && ` · ${count(p.currentStock)} in stock`}
                      {p.active === false && " · inactive"}
                    </div>
                  </div>
                  <strong className="price">{money(p.revenue)}</strong>
                </div>
              ))}
            </div>
          )}

          {/* Status breakdown */}
          <h2 style={{ fontSize: 18 }}>Orders by status</h2>
          <div className="toolbar">
            {report.byStatus.map((s) => (
              <div className="card" key={s.status} style={{ padding: 12, gap: 2, minWidth: 150 }}>
                <span
                  className="badge"
                  style={{ background: "transparent", color: STATUS_COLORS[s.status], alignSelf: "flex-start" }}
                >
                  {s.status}
                </span>
                <strong>{count(s.orderCount)} orders</strong>
                <span className="muted">{money(s.revenue)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
