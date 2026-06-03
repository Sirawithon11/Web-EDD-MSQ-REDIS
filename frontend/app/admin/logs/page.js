"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";

const ACTION_COLORS = {
  CREATE: "#16a34a",
  UPDATE: "#2563eb",
  DELETE: "#dc2626",
  UPDATE_STATUS: "#7c3aed",
  PLACE_ORDER: "#0891b2",
  DELETE_ORDER: "#dc2626",
};

// Actions available to filter by, per tab.
const ACTIONS_BY_TAB = {
  products: ["CREATE", "UPDATE", "DELETE"],
  orders: ["PLACE_ORDER", "UPDATE_STATUS", "DELETE_ORDER"],
};

// Build a short human-readable description of a log's details JSON.
function summarize(log) {
  const d = log.details || {};
  switch (log.action) {
    case "CREATE":
      return d.after?.name ? `Created "${d.after.name}"` : "Created";
    case "DELETE":
      return d.before?.name ? `Deleted "${d.before.name}"` : "Deleted";
    case "UPDATE": {
      const name = d.after?.name || d.before?.name;
      return name ? `Updated "${name}"` : "Updated";
    }
    case "UPDATE_STATUS":
      return `Status ${d.from ?? "?"} → ${d.to ?? "?"}`;
    case "PLACE_ORDER":
      return `Placed order · ${d.itemCount ?? "?"} item(s) · $${Number(d.total ?? 0).toFixed(2)}`;
    case "DELETE_ORDER":
      return `Deleted order (was ${d.status ?? "?"}, $${Number(d.total ?? 0).toFixed(2)})${d.byRole === "ADMIN" ? " by admin" : ""}`;
    default:
      return "";
  }
}

export default function AdminLogsPage() {
  const { user, loading: authLoading } = useAuth();
  const isAdmin = user?.role === "ADMIN";

  const [tab, setTab] = useState("products"); // "products" | "orders"
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [entityId, setEntityId] = useState("");
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ limit: "200" });
    if (action) params.set("action", action);
    if (actor) params.set("actor", actor);
    if (entityId) params.set("entityId", entityId);
    const fetcher = tab === "products" ? api.listProductAuditLogs : api.listOrderAuditLogs;
    fetcher(`?${params.toString()}`)
      .then((res) => setLogs(res.data))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [tab, action, actor, entityId]);

  useEffect(() => {
    if (!isAdmin) return;
    const t = setTimeout(load, 250); // debounce text filters
    return () => clearTimeout(t);
  }, [isAdmin, load]);

  // Switching tab resets the action filter (actions differ per entity).
  function switchTab(next) {
    setTab(next);
    setAction("");
  }

  if (authLoading) return <p className="muted">Loading…</p>;
  if (!isAdmin) return <p className="error">Admin access required.</p>;

  const entityLabel = tab === "products" ? "Product" : "Order";

  return (
    <div>
      <h1>Activity log</h1>

      <div className="toolbar">
        <button
          className={tab === "products" ? "btn" : "btn btn-ghost"}
          onClick={() => switchTab("products")}
        >
          Products
        </button>
        <button
          className={tab === "orders" ? "btn" : "btn btn-ghost"}
          onClick={() => switchTab("orders")}
        >
          Orders
        </button>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn btn-ghost" onClick={load} disabled={loading}>
          Refresh
        </button>
      </div>

      <div className="toolbar">
        <select value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">All actions</option>
          {ACTIONS_BY_TAB[tab].map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <input
          placeholder="Filter by admin/user email…"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          style={{ flex: 1, minWidth: 200 }}
        />
        <input
          type="number"
          min="1"
          placeholder={`${entityLabel} #`}
          value={entityId}
          onChange={(e) => setEntityId(e.target.value)}
          style={{ width: 120 }}
        />
        {(action || actor || entityId) && (
          <button
            className="btn btn-ghost"
            onClick={() => {
              setAction("");
              setActor("");
              setEntityId("");
            }}
          >
            Clear
          </button>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : logs.length === 0 ? (
        <p className="muted">No activity recorded yet.</p>
      ) : (
        logs.map((log) => (
          <div className="row" key={log.id}>
            <span
              className="badge"
              style={{ background: "transparent", color: ACTION_COLORS[log.action] || "var(--text)", border: "1px solid var(--border)" }}
            >
              {log.action}
            </span>
            <div>
              <div style={{ fontWeight: 600 }}>{summarize(log)}</div>
              <div className="muted">
                {entityLabel} #{log.entityId ?? "—"} · by {log.actorEmail}
              </div>
            </div>
            <span className="spacer" style={{ flex: 1 }} />
            <span className="muted" title={new Date(log.createdAt).toLocaleString()}>
              {new Date(log.createdAt).toLocaleString()}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
