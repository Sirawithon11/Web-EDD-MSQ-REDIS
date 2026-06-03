"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";

const STATUS_COLORS = {
  PENDING: "#b45309",
  PAID: "#2563eb",
  SHIPPED: "#7c3aed",
  DELIVERED: "#16a34a",
  CANCELLED: "#dc2626",
};

function OrdersList() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const placed = searchParams.get("placed");
  const [orders, setOrders] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.push("/login");
      return;
    }
    api
      .listOrders()
      .then(setOrders)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [user, authLoading, router]);

  if (authLoading || loading) return <p className="muted">Loading...</p>;

  return (
    <div>
      <h1>Your orders</h1>
      {placed && <p style={{ color: "green" }}>✅ Order #{placed} placed successfully!</p>}
      {error && <p className="error">{error}</p>}

      {orders.length === 0 ? (
        <p className="muted">You have no orders yet.</p>
      ) : (
        orders.map((order) => (
          <div className="card" key={order.id} style={{ marginBottom: 16, padding: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <strong>Order #{order.id}</strong>
              <span
                className="badge"
                style={{ background: "transparent", color: STATUS_COLORS[order.status] }}
              >
                {order.status}
              </span>
              <span className="muted">{new Date(order.createdAt).toLocaleDateString()}</span>
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
          </div>
        ))
      )}
    </div>
  );
}

export default function OrdersPage() {
  return (
    <Suspense fallback={<p className="muted">Loading...</p>}>
      <OrdersList />
    </Suspense>
  );
}
