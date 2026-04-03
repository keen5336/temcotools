"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { SessionData } from "@/lib/session";
import { useTheme, THEMES } from "@/components/ThemeProvider";

interface NavBarProps {
  session: SessionData;
}

export default function NavBar({ session }: NavBarProps) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();

  async function handleSignOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/signin");
    router.refresh();
  }

  return (
    <nav className="navbar bg-base-100 border-b border-base-200 px-4">
      <div className="navbar-start gap-1">
        <Link href="/" className="btn btn-ghost font-semibold">
          TemcoTools
        </Link>
        <Link href="/tools/rtv-label" className="btn btn-ghost btn-sm">
          Tools
        </Link>
        {session.role === "admin" && (
          <Link href="/admin/users" className="btn btn-ghost btn-sm">
            Admin
          </Link>
        )}
      </div>
      <div className="navbar-end gap-2">
        <span className="text-sm text-base-content/70">{session.displayName}</span>
        {session.role === "admin" && (
          <div className="badge badge-primary text-xs">Admin</div>
        )}
        <div className="dropdown dropdown-end">
          <div tabIndex={0} role="button" aria-label="Select theme" className="btn btn-ghost btn-sm">
            Theme
          </div>
          <ul
            tabIndex={0}
            className="dropdown-content menu bg-base-100 rounded-box shadow-md w-36 p-1 z-[1] border border-base-200"
          >
            {THEMES.map((t) => (
              <li key={t}>
                <button
                  onClick={() => setTheme(t)}
                  className={t === theme ? "active" : ""}
                >
                  {t}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <button onClick={handleSignOut} className="btn btn-ghost btn-sm">
          Sign out
        </button>
      </div>
    </nav>
  );
}
