"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";

const EMPTY = {
  name: "",
  price: "",
  stock: "",
  categoryId: "",
  sku: "",
  imageUrl: "",
  description: "",
  active: true,
};

export default function AdminProductsPage() {
  const { user, loading: authLoading } = useAuth();

  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  // editingId === null means the form is in "create" mode.
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);

  const isAdmin = user?.role === "ADMIN";

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: "200" });
    if (search) params.set("search", search);
    api
      .adminListProducts(`?${params.toString()}`)
      .then((res) => {
        setProducts(res.data);
        setPagination(res.pagination);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [search, page]);

  useEffect(() => {
    if (!isAdmin) return;
    api.listCategories().then(setCategories).catch(() => {});
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) return;
    const t = setTimeout(load, 250); // debounce search
    return () => clearTimeout(t);
  }, [isAdmin, load]);

  if (authLoading) return <p className="muted">Loading...</p>;
  if (!isAdmin) return <p className="error">Admin access required.</p>;

  function resetForm() {
    setEditingId(null);
    setForm(EMPTY);
  }

  function startEdit(p) {
    setEditingId(p.id);
    setForm({
      name: p.name ?? "",
      price: String(p.price ?? ""),
      stock: String(p.stock ?? ""),
      categoryId: String(p.categoryId ?? ""),
      sku: p.sku ?? "",
      imageUrl: p.imageUrl ?? "",
      description: p.description ?? "",
      active: p.active ?? true,
    });
    setError("");
    setMessage("");
  }

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  // Read a picked file from disk into a base64 data URL stored in imageUrl.
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB (server JSON limit is 8 MB)
  function pickImageFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Please choose an image file.");
      e.target.value = "";
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError(`Image is too large (max ${MAX_IMAGE_BYTES / (1024 * 1024)} MB).`);
      e.target.value = "";
      return;
    }
    setError("");
    const reader = new FileReader();
    reader.onload = () => set("imageUrl", reader.result);
    reader.onerror = () => setError("Could not read the selected file.");
    reader.readAsDataURL(file);
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setMessage("");

    if (!form.name || form.price === "" || !form.categoryId) {
      setError("Name, price and category are required.");
      return;
    }

    const payload = {
      name: form.name,
      description: form.description,
      price: Number(form.price),
      stock: form.stock === "" ? 0 : Number(form.stock),
      categoryId: Number(form.categoryId),
      imageUrl: form.imageUrl || undefined,
    };
    if (form.sku) payload.sku = form.sku;

    setSaving(true);
    try {
      if (editingId === null) {
        await api.createProduct(payload);
        setMessage("Product created.");
      } else {
        await api.updateProduct(editingId, { ...payload, active: form.active });
        setMessage("Product updated.");
      }
      resetForm();
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(p) {
    if (!confirm(`Delete "${p.name}"? This cannot be undone.`)) return;
    setError("");
    setMessage("");
    try {
      await api.deleteProduct(p.id);
      setMessage("Product deleted.");
      if (editingId === p.id) resetForm();
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      <h1>Manage products</h1>

      {error && <p className="error">{error}</p>}
      {message && <p style={{ color: "green" }}>{message}</p>}

      <form className="form" style={{ maxWidth: "none", margin: "0 0 24px" }} onSubmit={onSubmit}>
        <h2 style={{ margin: 0 }}>{editingId === null ? "New product" : `Edit #${editingId}`}</h2>

        <div className="toolbar" style={{ marginBottom: 0 }}>
          <input
            placeholder="Name"
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            style={{ flex: 2, minWidth: 200 }}
          />
          <input
            type="number"
            step="0.01"
            min="0"
            placeholder="Price"
            value={form.price}
            onChange={(e) => set("price", e.target.value)}
            style={{ width: 110 }}
          />
          <input
            type="number"
            min="0"
            placeholder="Stock"
            value={form.stock}
            onChange={(e) => set("stock", e.target.value)}
            style={{ width: 100 }}
          />
          <select
            value={form.categoryId}
            onChange={(e) => set("categoryId", e.target.value)}
          >
            <option value="">Category…</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="toolbar" style={{ marginBottom: 0 }}>
          <input
            placeholder="SKU (optional)"
            value={form.sku}
            onChange={(e) => set("sku", e.target.value)}
            style={{ flex: 1, minWidth: 160 }}
          />
          <input
            placeholder="Image URL or pick a file →"
            value={form.imageUrl?.startsWith("data:") ? "" : form.imageUrl}
            onChange={(e) => set("imageUrl", e.target.value)}
            style={{ flex: 2, minWidth: 200 }}
          />
          <input type="file" accept="image/*" onChange={pickImageFile} />
          {editingId !== null && (
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => set("active", e.target.checked)}
              />
              Active
            </label>
          )}
        </div>

        {form.imageUrl && (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <img
              src={form.imageUrl}
              alt="preview"
              style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border)" }}
            />
            <span className="muted">
              {form.imageUrl.startsWith("data:") ? "Uploaded from your computer" : "From URL"}
            </span>
            <button type="button" className="btn btn-ghost" onClick={() => set("imageUrl", "")}>
              Remove image
            </button>
          </div>
        )}

        <textarea
          placeholder="Description (optional)"
          value={form.description}
          onChange={(e) => set("description", e.target.value)}
          rows={3}
          style={{ padding: 10, border: "1px solid var(--border)", borderRadius: 8, fontSize: 14 }}
        />

        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" type="submit" disabled={saving}>
            {saving ? "Saving…" : editingId === null ? "Create product" : "Save changes"}
          </button>
          {editingId !== null && (
            <button className="btn btn-ghost" type="button" onClick={resetForm} disabled={saving}>
              Cancel
            </button>
          )}
        </div>
      </form>

      <div className="toolbar">
        <input
          placeholder="Search by name or SKU…"
          value={search}
          onChange={(e) => {
            setPage(1);
            setSearch(e.target.value);
          }}
          style={{ flex: 1, minWidth: 220 }}
        />
        <span className="muted" style={{ alignSelf: "center" }}>
          {pagination.total.toLocaleString()} products
        </span>
      </div>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : products.length === 0 ? (
        <p className="muted">No products found.</p>
      ) : (
        products.map((p) => (
          <div className="row" key={p.id}>
            {p.imageUrl && <img src={p.imageUrl} alt={p.name} />}
            <div>
              <div style={{ fontWeight: 600 }}>
                {p.name}{" "}
                {!p.active && <span className="badge" style={{ background: "#fee2e2", color: "var(--danger)" }}>inactive</span>}
              </div>
              <div className="muted">
                {p.category?.name} · ${Number(p.price).toFixed(2)} · {p.stock} in stock · {p.sku}
              </div>
            </div>
            <div className="spacer" />
            <button className="btn btn-ghost" onClick={() => startEdit(p)}>
              Edit
            </button>
            <button className="btn btn-danger" onClick={() => onDelete(p)}>
              Delete
            </button>
          </div>
        ))
      )}

      {pagination.pages > 1 && (
        <div className="toolbar" style={{ marginTop: 20, justifyContent: "center" }}>
          <button className="btn btn-ghost" disabled={page <= 1} onClick={() => setPage(1)}>
            « First
          </button>
          <button className="btn btn-ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Prev
          </button>
          <span className="muted" style={{ alignSelf: "center" }}>
            Page {pagination.page} of {pagination.pages}
          </span>
          <button
            className="btn btn-ghost"
            disabled={page >= pagination.pages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
          <button
            className="btn btn-ghost"
            disabled={page >= pagination.pages}
            onClick={() => setPage(pagination.pages)}
          >
            Last »
          </button>
        </div>
      )}
    </div>
  );
}
