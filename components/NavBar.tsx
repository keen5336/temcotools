"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { SessionData } from "@/lib/session";
import { useTheme, THEMES } from "@/components/ThemeProvider";
import LabelRelayMenu from "@/components/labels/LabelRelayMenu";
import { useLabelRelay } from "@/components/labels/LabelRelayProvider";

interface NavBarProps {
  session: SessionData;
}

export default function NavBar({ session }: NavBarProps) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const { suspend } = useLabelRelay();

  async function handleSignOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    suspend();
    router.push("/signin");
    router.refresh();
  }

  function handleSetTheme(t: typeof THEMES[number]) {
    setTheme(t);
    (document.activeElement as HTMLElement)?.blur();
  }

  return (
    <nav className="navbar bg-base-100 border-b border-base-200 px-2 sm:px-4">
      <div className="navbar-start min-w-0 flex-1 items-start">
        <Link href="/" className="btn btn-ghost shrink-0 px-2 sm:px-4 font-semibold">
          TemcoTools
        </Link>
      </div>
      <div className="navbar-end w-auto min-w-0 gap-1">
        <LabelRelayMenu />
        <div className="dropdown dropdown-end min-w-0">
          <div tabIndex={0} role="button" className="btn btn-ghost btn-sm max-w-20 sm:max-w-52">
            <span className="truncate">{session.displayName}</span>
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
