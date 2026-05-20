"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Login() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      router.push("/");
    } else {
      setError("Wrong password. Try again.");
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "var(--bg)", padding: 24,
    }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="https://outreachengine.co/assets/logo-full-ghBZLqO4.webp"
            alt="Outreach Engine"
            style={{ height: 32, objectFit: "contain" }}
          />
          <p style={{ marginTop: 10, fontSize: 14, color: "var(--text-secondary)" }}>
            Team workspace
          </p>
        </div>

        {/* Card */}
        <div style={{
          background: "var(--surface)", borderRadius: 20,
          border: "1px solid var(--border)", boxShadow: "var(--card-shadow)",
          padding: 32,
        }}>
          <h1 style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)", marginBottom: 6 }}>
            Sign in to Brain
          </h1>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 24 }}>
            Enter your team password to continue.
          </p>

          <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <input
              type="password"
              placeholder="Team password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              style={{
                width: "100%", padding: "12px 14px", borderRadius: 12,
                background: "var(--input-bg)", border: "1px solid var(--border-2)",
                color: "var(--text-primary)", fontSize: 14, outline: "none",
                fontFamily: "inherit",
              }}
            />
            {error && (
              <p style={{ fontSize: 13, color: "#dc2626", margin: 0 }}>{error}</p>
            )}
            <button
              type="submit"
              disabled={loading || !password}
              style={{
                width: "100%", padding: "13px", borderRadius: 12,
                background: loading || !password ? "var(--surface-2)" : "linear-gradient(135deg, #3c83f6, #5e76ed)",
                color: loading || !password ? "var(--text-muted)" : "white",
                border: "none", fontSize: 14, fontWeight: 600,
                cursor: loading || !password ? "not-allowed" : "pointer",
                fontFamily: "inherit", transition: "all 0.15s",
              }}
            >
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>

        <p style={{ textAlign: "center", marginTop: 20, fontSize: 12, color: "var(--text-muted)" }}>
          Outreach Engine · Internal Tool
        </p>
      </div>
    </div>
  );
}
