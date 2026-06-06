"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";

// YYYY-MM-DD for <input type="date">
function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

const money = (n) =>
  `$${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const count = (n) => Number(n || 0).toLocaleString();

export default function AdminAffinityPage() {
  const { user, loading: authLoading } = useAuth();
  const isAdmin = user?.role === "ADMIN";

  const today = new Date();
  const quarterAgo = new Date(today.getTime() - 90 * 864e5);
  const [from, setFrom] = useState(isoDay(quarterAgo));
  const [to, setTo] = useState(isoDay(today));
  const [limit, setLimit] = useState(20);

  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ from, to, limit: String(limit) });
    api
      .productAffinity(`?${params.toString()}`)
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

  const maxCo = report ? Math.max(1, ...report.pairs.map((p) => p.coCount)) : 1;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ marginBottom: 0 }}>Product affinity</h1>
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
      <p className="muted" style={{ marginTop: 4 }}>
        Products frequently bought together (order_items self-join).
      </p>

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
          Top pairs
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {[10, 20, 50, 100].map((n) => (
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
        <p className="muted">Pairing baskets…</p>
      ) : !report ? null : report.pairs.length === 0 ? (
        <p className="muted">No co-purchases in this range.</p>
      ) : (
        <div style={{ marginTop: 16 }}>
          {report.pairs.map((p, i) => (
            <div className="row" key={`${p.a.productId}-${p.b.productId}`}>
              <span className="muted" style={{ width: 24, textAlign: "right" }}>
                {i + 1}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {p.a.name} <span className="muted">+</span> {p.b.name}
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
                  <div style={{ width: `${(p.coCount / maxCo) * 100}%`, height: "100%", background: "var(--primary)" }} />
                </div>
                <div className="muted" style={{ marginTop: 4 }}>
                  bought together {count(p.coCount)}× · {count(p.orderCount)} orders
                </div>
              </div>
              <strong className="price">{money(p.pairRevenue)}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
