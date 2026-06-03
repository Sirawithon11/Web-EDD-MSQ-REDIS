"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { api } from "@/lib/api";

export default function HomePage() {
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, pages: 1 });
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState("newest");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.listCategories().then(setCategories).catch(() => {});
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (category) params.set("category", category);
    if (sort) params.set("sort", sort);
    params.set("page", String(page));
    params.set("limit", "200");
    api
      .listProducts(`?${params.toString()}`)
      .then((res) => {
        setProducts(res.data);
        setPagination(res.pagination);
      })
      .catch((e) => console.error(e))
      .finally(() => setLoading(false));
  }, [search, category, sort, page]);

  useEffect(() => {
    const t = setTimeout(load, 250); // debounce search
    return () => clearTimeout(t);
  }, [load]);

  const totalCount = categories.reduce((n, c) => n + (c.productCount || 0), 0);

  function selectCategory(slug) {
    setPage(1);
    setCategory(slug);
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <h3>Categories</h3>
        <button
          className={`cat-item ${category === "" ? "active" : ""}`}
          onClick={() => selectCategory("")}
        >
          <span>All products</span>
          {totalCount > 0 && <span className="cat-count">{totalCount}</span>}
        </button>
        {categories.map((c) => (
          <button
            key={c.id}
            className={`cat-item ${category === c.slug ? "active" : ""}`}
            onClick={() => selectCategory(c.slug)}
          >
            <span>{c.name}</span>
            <span className="cat-count">{c.productCount ?? 0}</span>
          </button>
        ))}
      </aside>

      <div className="content">
        <h1>Products</h1>

        <div className="toolbar">
          <input
            placeholder="Search products..."
            value={search}
            onChange={(e) => {
              setPage(1);
              setSearch(e.target.value);
            }}
            style={{ flex: 1, minWidth: 200 }}
          />
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="newest">Newest</option>
            <option value="price_asc">Price: low to high</option>
            <option value="price_desc">Price: high to low</option>
          </select>
        </div>

        {loading ? (
          <p className="muted">Loading...</p>
        ) : products.length === 0 ? (
          <p className="muted">No products found.</p>
        ) : (
          <div className="grid">
            {products.map((p) => (
              <Link key={p.id} href={`/products/${p.id}`} className="card">
                {p.imageUrl && <img src={p.imageUrl} alt={p.name} />}
                <div className="card-body">
                  <span className="badge">{p.category?.name}</span>
                  <span className="card-title">{p.name}</span>
                  <span className="price">${Number(p.price).toFixed(2)}</span>
                  <span className="muted">{p.stock > 0 ? `${p.stock} in stock` : "Out of stock"}</span>
                </div>
              </Link>
            ))}
          </div>
        )}

        {pagination.pages > 1 && (
          <div className="toolbar" style={{ marginTop: 20, justifyContent: "center" }}>
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
          </div>
        )}
      </div>
    </div>
  );
}
