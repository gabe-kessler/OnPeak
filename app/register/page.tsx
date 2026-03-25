"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const S = {
  bg: "#000000",
  surface: "#0f0f0f",
  elevated: "#1a1a1a",
  border: "#222222",
  text: "#ffffff",
  muted: "#888888",
  faint: "#555555",
  orange: "#ff6600",
  red: "#ff3d3d",
};

export default function Register() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);

  async function handleSubmit(e: { preventDefault: () => void }) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const res  = await fetch("/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, email, password }) });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) { setError(data.error || "Something went wrong."); return; }
    router.push("/login");
  }

  const inputStyle = {
    width: "100%", background: S.elevated, border: `1px solid ${S.border}`,
    borderRadius: "4px", padding: "8px 12px", color: S.text, fontSize: "14px", outline: "none",
  };

  return (
    <main className="min-h-screen flex items-center justify-center p-8" style={{ background: S.bg, color: S.text }}>
      <div className="w-full max-w-sm">
        <a href="/" className="text-sm mb-8 block" style={{ color: S.muted }}>← Back</a>
        <h1 className="text-2xl font-bold mb-1">Create account</h1>
        <p className="text-sm mb-6" style={{ color: S.muted }}>Start with $10,000 in paper cash</p>

        <form onSubmit={handleSubmit} className="rounded p-6" style={{ background: S.surface, border: `1px solid ${S.border}` }}>
          <div className="mb-4">
            <label className="text-xs font-medium mb-1.5 block" style={{ color: S.muted }}>Username</label>
            <input style={inputStyle} placeholder="satoshi" type="text" value={username} onChange={(e) => setUsername(e.target.value)} required />
          </div>
          <div className="mb-4">
            <label className="text-xs font-medium mb-1.5 block" style={{ color: S.muted }}>Email</label>
            <input style={inputStyle} placeholder="you@example.com" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="mb-5">
            <label className="text-xs font-medium mb-1.5 block" style={{ color: S.muted }}>Password</label>
            <input style={inputStyle} placeholder="••••••••" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <p className="text-sm mb-4" style={{ color: S.red }}>{error}</p>}
          <button type="submit" disabled={loading} className="w-full py-2 rounded font-bold text-sm mb-4 disabled:opacity-50 transition-colors" style={{ background: S.orange, color: "#000000" }}>
            {loading ? "Creating account..." : "Create account"}
          </button>
          <p className="text-center text-sm" style={{ color: S.faint }}>
            Already have an account?{" "}<a href="/login" style={{ color: S.orange }}>Sign in</a>
          </p>
        </form>
      </div>
    </main>
  );
}
