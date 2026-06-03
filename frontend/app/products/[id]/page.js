"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";

export default function ProductDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const { user } = useAuth();
  const [product, setProduct] = useState(null);
  const [quantity, setQuantity] = useState(1);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    api.getProduct(id).then(setProduct).catch((e) => setError(e.message));
  }, [id]);

  async function addToCart() {
    setError("");
    setMessage("");
    if (!user) {
      router.push("/login");
      return;
    }
    setAdding(true);
    try {
      await api.addToCart(product.id, quantity);
      setMessage("Added to cart!");
    } catch (e) {
      setError(e.message);
    } finally {
      setAdding(false);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!product) return <p className="muted">Loading...</p>;

  return (
    <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
      {product.imageUrl && (
        <img
          src={product.imageUrl}
          alt={product.name}
          style={{ width: 360, height: 360, objectFit: "cover", borderRadius: 12 }}
        />
      )}
      <div style={{ flex: 1, minWidth: 280 }}>
        <span className="badge">{product.category?.name}</span>
        <h1 style={{ marginTop: 12 }}>{product.name}</h1>
        <p className="price" style={{ fontSize: 24 }}>
          ${Number(product.price).toFixed(2)}
        </p>
        <p className="muted">{product.description}</p>
        <p className="muted">SKU: {product.sku}</p>
        <p className="muted">{product.stock > 0 ? `${product.stock} in stock` : "Out of stock"}</p>

        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 16 }}>
          <input
            type="number"
            min="1"
            max={product.stock}
            value={quantity}
            onChange={(e) => setQuantity(Math.max(1, Number(e.target.value)))}
            style={{ width: 70, padding: 8, borderRadius: 8, border: "1px solid var(--border)" }}
          />
          <button className="btn" onClick={addToCart} disabled={adding || product.stock <= 0}>
            {adding ? "Adding..." : "Add to cart"}
          </button>
        </div>
        {message && <p style={{ color: "green", marginTop: 10 }}>{message}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
