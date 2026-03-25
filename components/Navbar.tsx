"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";

const S = {
  bg: "#f6f8fa",
  surface: "#ffffff",
  border: "#d0d7de",
  text: "#1f2328",
  muted: "#656d76",
  blue: "#0969da",
};

export default function Navbar() {
  const router   = useRouter();
  const pathname = usePathname();
  const [username, setUsername] = useState<string | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem("user");
    if (stored) setUsername(JSON.parse(stored).username);
  }, []);

  function handleSignOut() {
    localStorage.removeItem("user");
    setUsername(null);
    router.push("/");
  }

  function isActive(href: string) {
    return pathname === href || pathname.startsWith(href + "/");
  }

  return (
    <nav
      style={{ background: S.surface, borderBottom: `1px solid ${S.border}` }}
      className="px-8 py-3 flex items-center justify-between"
    >
      <a href="/" className="font-bold text-base tracking-tight" style={{ color: "#000000" }}>
        OnPeak
      </a>

      <div className="flex gap-6 items-center">
        {[
          { href: "/markets",     label: "Markets", match: "/markets" },
          { href: "/map",         label: "Live Map" },
          { href: "/portfolio",   label: "Portfolio" },
        ].map(({ href, label, match }) => {
          const active = isActive(match ?? href);
          return (
            <a
              key={href}
              href={href}
              className="text-sm transition-colors duration-150"
              style={{ color: active ? S.blue : S.muted, fontWeight: active ? 600 : 400 }}
            >
              {label}
            </a>
          );
        })}

        <div style={{ width: "1px", height: "16px", background: S.border }} />

        {username ? (
          <>
            <span className="text-sm" style={{ color: S.muted }}>{username}</span>
            <button
              onClick={handleSignOut}
              className="text-sm transition-colors"
              style={{ color: S.muted }}
              onMouseEnter={e => (e.currentTarget.style.color = S.text)}
              onMouseLeave={e => (e.currentTarget.style.color = S.muted)}
            >
              Sign out
            </button>
          </>
        ) : (
          <>
            <a href="/login" className="text-sm" style={{ color: isActive("/login") ? S.blue : S.muted }}>
              Sign in
            </a>
            <a
              href="/register"
              className="text-sm font-semibold px-3 py-1.5 rounded transition-colors"
              style={{ background: S.blue, color: "#ffffff" }}
              onMouseEnter={e => (e.currentTarget.style.background = "#0757ba")}
              onMouseLeave={e => (e.currentTarget.style.background = S.blue)}
            >
              Register
            </a>
          </>
        )}
      </div>
    </nav>
  );
}
