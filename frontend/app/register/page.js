"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";

export default function RegisterPage() {
  const { register } = useAuth();
  const router = useRouter();
  const [form, setForm] = useState({ name: "", email: "", password: "", phone: "", address: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  function update(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await register(form);
      router.push("/");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="form" onSubmit={onSubmit}>
      <h1>Create account</h1>
      <label>Name</label>
      <input value={form.name} onChange={(e) => update("name", e.target.value)} required />
      <label>Email</label>
      <input type="email" value={form.email} onChange={(e) => update("email", e.target.value)} required />
      <label>Password</label>
      <input
        type="password"
        value={form.password}
        onChange={(e) => update("password", e.target.value)}
        required
      />
      <label>Phone (optional)</label>
      <input value={form.phone} onChange={(e) => update("phone", e.target.value)} />
      <label>Address (optional)</label>
      <input value={form.address} onChange={(e) => update("address", e.target.value)} />
      {error && <p className="error">{error}</p>}
      <button className="btn" type="submit" disabled={loading}>
        {loading ? "Creating..." : "Create account"}
      </button>
      <p className="muted">
        Already have an account? <Link href="/login">Login</Link>
      </p>
    </form>
  );
}
