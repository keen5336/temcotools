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
      <div className="navbar-start min-w-0 flex-1 items-start">
        <Link href="/" className="btn btn-ghost shrink-0 font-semibold">
          TemcoTools
        </Link>
        <div className="hidden min-w-0 flex-1 flex-wrap gap-1 ml-2 sm:flex">
          <Link href="/tools/mars" className="btn btn-ghost btn-sm">
            MARS Tracking
          </Link>
          <Link href="/tools/rtv-label" className="btn btn-ghost btn-sm">
            MARS Label
          </Link>
          <Link href="/tools/label-relay" className="btn btn-ghost btn-sm">
            Label Relay Mode
          </Link>
          <Link href="/tools/lpn-put-away" className="btn btn-ghost btn-sm">
            LPN Put Away
          </Link>
          <Link href="/tools/barcode-generator" className="btn btn-ghost btn-sm">
            Barcode Generator
          </Link>
          <Link href="/tools/scan-lists" className="btn btn-ghost btn-sm">
            Scan Lists
          </Link>
          <Link href="/tools/pick-waves" className="btn btn-ghost btn-sm">
            Pick Waves
          </Link>
          <Link href="/tools/route-recon" className="btn btn-ghost btn-sm">
            Route Recon
          </Link>
          {(session.role === "admin" || session.role === "manager") && (
            <Link href="/management/labels" className="btn btn-ghost btn-sm">
              Label Setup
            </Link>
          )}
          {session.role === "admin" && (
            <Link href="/admin/files" className="btn btn-ghost btn-sm">
              File Manager
            </Link>
          )}
          {session.role === "admin" && (
            <Link href="/admin/scanner-diagnostic" className="btn btn-ghost btn-sm">
              Scanner Test
            </Link>
          )}
        </div>
      </div>
      <div className="navbar-end w-auto shrink-0">
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
            {(session.role === "admin" || session.role === "manager") && (
              <li>
                <Link href="/management/labels">Label Configuration</Link>
              </li>
            )}
            <li>
              <Link href="/tools/route-recon">Route Recon</Link>
            </li>
            <li>
              <Link href="/tools/label-relay">Label Relay Mode</Link>
            </li>
            {session.role === "admin" && (
              <li>
                <Link href="/admin/users">User Management</Link>
              </li>
            )}
            {session.role === "admin" && (
              <li>
                <Link href="/admin/scanner-diagnostic">Scanner Diagnostic</Link>
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
