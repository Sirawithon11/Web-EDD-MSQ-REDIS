"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";

export default function CartPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [cart, setCart] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.push("/login");
      return;
    }
    api.getCart().then(setCart).catch((e) => setError(e.message));
  }, [user, authLoading, router]);

  async function changeQty(itemId, quantity) {
    if (quantity < 1) return;
    setBusy(true);
    try {
      setCart(await api.updateCartItem(itemId, quantity));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(itemId) {
    setBusy(true);
    try {
      setCart(await api.removeCartItem(itemId));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function checkout() {
    setBusy(true);
    setError("");
    try {
      const order = await api.checkout();
      router.push(`/orders?placed=${order.id}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (authLoading || !cart) return <p className="muted">Loading...</p>;

  return (
    <div>
      <h1>Your cart</h1>
      {error && <p className="error">{error}</p>}

      {cart.items.length === 0 ? (
        <p className="muted">
          Your cart is empty. <Link href="/">Browse products</Link>
        </p>
      ) : (
        <>
          {cart.items.map((item) => (
            <div className="row" key={item.id}>
              {item.product?.imageUrl && <img src={item.product.imageUrl} alt="" />}
              <div>
                <div className="card-title">{item.product?.name || `Product #${item.productId}`}</div>
                <div className="muted">${Number(item.product?.price || 0).toFixed(2)} each</div>
              </div>
              <div className="spacer" />
              <input
                type="number"
                min="1"
                value={item.quantity}
                disabled={busy}
                onChange={(e) => changeQty(item.id, Number(e.target.value))}
                style={{ width: 64, padding: 6, borderRadius: 8, border: "1px solid var(--border)" }}
              />
              <strong style={{ width: 90, textAlign: "right" }}>
                ${item.lineTotal.toFixed(2)}
              </strong>
              <button className="btn btn-danger" disabled={busy} onClick={() => remove(item.id)}>
                Remove
              </button>
            </div>
          ))}

          <div className="row" style={{ justifyContent: "flex-end" }}>
            <span className="spacer" />
            <h2 style={{ margin: 0 }}>Subtotal: ${cart.subtotal.toFixed(2)}</h2>
          </div>

          <div style={{ textAlign: "right", marginTop: 16 }}>
            <button className="btn" disabled={busy} onClick={checkout}>
              {busy ? "Processing..." : "Checkout"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
