"use client";

import Link from "next/link";
import { useAuth } from "@/context/AuthContext";

export default function Navbar() {
  const { user, logout } = useAuth();

  return (
    <nav className="navbar">
      <div className="navbar-inner">
        <Link href="/" className="brand">
          🛍️ ShopMicro
        </Link>
        <div className="nav-links">
          <Link href="/">Products</Link>
          <Link href="/cart">Cart</Link>
          {user ? (
            <>
              <Link href="/orders">Orders</Link>
              <span className="muted">Hi, {user.name?.split(" ")[0]}</span>
              <button className="btn btn-ghost" onClick={logout}>
                Logout
              </button>
            </>
          ) : (
            <>
              <Link href="/login">Login</Link>
              <Link href="/register" className="btn">
                Sign up
              </Link>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
