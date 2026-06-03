"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";

const STATUSES = ["PENDING", "PAID", "SHIPPED", "DELIVERED", "CANCELLED"];
const STATUS_COLORS = {
  PENDING: "#b45309",
  PAID: "#2563eb",
  SHIPPED: "#7c3aed",
  DELIVERED: "#16a34a",
  CANCELLED: "#dc2626",
};

export default function AdminOrdersPage() {
  const { user, loading: authLoading } = useAuth();
  const isAdmin = user?.role === "ADMIN";

  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    api
      .adminListOrders("?limit=200")
      .then((res) => setOrders(res.data))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    load();
  }, [isAdmin, load]);

  if (authLoading) return <p className="muted">Loading…</p>;
  if (!isAdmin) return <p className="error">Admin access required.</p>;

  async function changeStatus(id, status) {
    setError("");
    setMessage("");
    setBusyId(id);
    try {
      const updated = await api.updateOrderStatus(id, status);
      setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, status: updated.status } : o)));
      setMessage(`Order #${id} → ${updated.status}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(id) {
    if (!confirm(`Delete order #${id}? Its stock will be returned. This cannot be undone.`)) return;
    setError("");
    setMessage("");
    setBusyId(id);
    try {
      await api.deleteOrder(id);
      setOrders((prev) => prev.filter((o) => o.id !== id));
      setMessage(`Order #${id} deleted.`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <h1>Manage orders</h1>
      {error && <p className="error">{error}</p>}
      {message && <p style={{ color: "green" }}>{message}</p>}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : orders.length === 0 ? (
        <p className="muted">No orders.</p>
      ) : (
        orders.map((order) => (
          <div className="card" key={order.id} style={{ marginBottom: 16, padding: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <strong>Order #{order.id}</strong>
              <span className="muted">user #{order.userId}</span>
              <span
                className="badge"
                style={{ background: "transparent", color: STATUS_COLORS[order.status] }}
              >
                {order.status}
              </span>
              <span className="muted">{new Date(order.createdAt).toLocaleString()}</span>
              <span className="spacer" style={{ flex: 1 }} />
              <strong className="price">${Number(order.total).toFixed(2)}</strong>
            </div>

            <div style={{ marginTop: 10 }}>
              {order.items.map((item) => (
                <div key={item.id} className="muted" style={{ fontSize: 14 }}>
                  {item.quantity} × {item.productName} — ${Number(item.price).toFixed(2)}
                </div>
              ))}
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
              <label className="muted">Status</label>
              <select
                value={order.status}
                disabled={busyId === order.id}
                onChange={(e) => changeStatus(order.id, e.target.value)}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <span className="spacer" style={{ flex: 1 }} />
              <button
                className="btn btn-danger"
                disabled={busyId === order.id}
                onClick={() => handleDelete(order.id)}
              >
                Delete
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
