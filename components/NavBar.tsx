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

  function handleSetTheme(t: typeof THEMES[number]) {
    setTheme(t);
    (document.activeElement as HTMLElement)?.blur();
  }

  return (
    <nav className="navbar bg-base-100 border-b border-base-200 px-4">
      <div className="navbar-start">
        <Link href="/" className="btn btn-ghost font-semibold">
          TemcoTools
        </Link>
        <div className="hidden sm:flex gap-1 ml-2">
          <Link href="/tools/mars" className="btn btn-ghost btn-sm">
            MARS Tracking
          </Link>
          <Link href="/tools/rtv-label" className="btn btn-ghost btn-sm">
            MARS Label
          </Link>
          <Link href="/tools/barcode-generator" className="btn btn-ghost btn-sm">
            Barcode Generator
          </Link>
          {session.role === "admin" && (
            <Link href="/admin/files" className="btn btn-ghost btn-sm">
              File Manager
            </Link>
          )}
        </div>
      </div>
      <div className="navbar-end">
        <div className="dropdown dropdown-end">
          <div tabIndex={0} role="button" className="btn btn-ghost btn-sm">
            {session.displayName}
          </div>
          <ul
            tabIndex={0}
            className="dropdown-content menu bg-base-100 rounded-box shadow-md w-44 p-1 z-[1] border border-base-200"
          >
            <li>
              <details>
                <summary>Theme</summary>
                <ul>
                  {THEMES.map((t) => (
                    <li key={t}>
                      <button
                        onClick={() => handleSetTheme(t)}
                        className={t === theme ? "active" : ""}
                      >
                        {t}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            </li>
            {session.role === "admin" && (
              <li>
                <Link href="/admin/files">File Manager</Link>
              </li>
            )}
            {session.role === "admin" && (
              <li>
                <Link href="/admin/users">User Management</Link>
              </li>
            )}
            <li>
              <button onClick={handleSignOut}>Sign out</button>
            </li>
          </ul>
        </div>
      </div>
    </nav>
  );
}
