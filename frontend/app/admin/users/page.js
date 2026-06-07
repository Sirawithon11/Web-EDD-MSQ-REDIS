"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";

export default function AdminUsersPage() {
  const { user, loading: authLoading } = useAuth();
  const isAdmin = user?.role === "ADMIN";

  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    api
      .listUsers()
      .then((res) => setUsers(res))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    load();
  }, [isAdmin, load]);

  // Client-side filter by name/email (the list is admin-only and already cached
  // server-side, so filtering here avoids extra round-trips).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.name?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q)
    );
  }, [users, search]);

  if (authLoading) return <p className="muted">Loading…</p>;
  if (!isAdmin) return <p className="error">Admin access required.</p>;

  return (
    <div>
      <h1>Users</h1>

      <div className="toolbar">
        <input
          placeholder="Search by name or email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 200 }}
        />
        <span className="muted">{filtered.length} user(s)</span>
        <button className="btn btn-ghost" onClick={load} disabled={loading}>
          Refresh
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="muted">No users found.</p>
      ) : (
        filtered.map((u) => (
          <div className="row" key={u.id}>
            <span
              className="badge"
              style={{
                background: "transparent",
                color: u.role === "ADMIN" ? "#7c3aed" : "var(--text)",
                border: "1px solid var(--border)",
              }}
            >
              {u.role}
            </span>
            <div>
              <div style={{ fontWeight: 600 }}>{u.name}</div>
              <div className="muted">{u.email}</div>
            </div>
            <span className="spacer" style={{ flex: 1 }} />
            <div className="muted" style={{ textAlign: "right" }}>
              <div>
                {u.ordersCount ?? 0} order(s) · ${Number(u.totalSpent ?? 0).toFixed(2)}
              </div>
              <div title={new Date(u.createdAt).toLocaleString()}>
                Joined {new Date(u.createdAt).toLocaleDateString()}
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
