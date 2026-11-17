"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { SessionData } from "@/lib/session";
import { useTheme, THEMES } from "@/components/ThemeProvider";
import LabelRelayMenu from "@/components/labels/LabelRelayMenu";
import { useLabelRelay } from "@/components/labels/LabelRelayProvider";
import MobileToolDrawer from "@/components/tools/MobileToolDrawer";
import { useApiRelays } from "@/components/api-relay/ApiRelayProvider";

interface NavBarProps {
  session: SessionData;
}

export default function NavBar({ session }: NavBarProps) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const { suspend } = useLabelRelay();
  const api = useApiRelays();

  async function handleSignOut() {
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error();
    } catch { alert("Sign-out could not be confirmed. Reload to check your current sign-in state."); return; }
    suspend();
    api.suspend();
    router.push("/signin");
    router.refresh();
  }

  function handleSetTheme(t: typeof THEMES[number]) {
    setTheme(t);
    (document.activeElement as HTMLElement)?.blur();
  }

  return (
    <nav className="navbar bg-base-100 border-b border-base-200 px-2 sm:px-4">
      <div className="navbar-start min-w-0 flex-1 items-center gap-1">
        <MobileToolDrawer />
        <Link href="/" className="btn btn-ghost min-w-0 px-2 sm:px-4 font-semibold text-sm sm:text-base">
          <span className="truncate">TemcoTools</span>
        </Link>
      </div>
      <div className="navbar-end w-auto min-w-0 gap-1">
        <LabelRelayMenu />
        <div className="dropdown dropdown-end min-w-0">
          <div tabIndex={0} role="button" className="btn btn-ghost btn-sm max-w-16 sm:max-w-52">
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
            <li><Link href="/configuration">Configuration</Link></li>
            <li><Link href="/account/security">Account security</Link></li>
            {session.role === "admin" && <li><Link href="/configuration#mcp">MCP clients</Link></li>}
            {session.role === "admin" && <li><Link href="/admin/api-relays">API Relay Management</Link></li>}
            <li>
              <Link href="/tools/api-relay">API Relays</Link>
            </li>
            <li>
              <Link href="/tools/route-recon">Route Recon</Link>
            </li>
            <li>
              <Link href="/tools/inventory-audit">Inventory Audit</Link>
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
