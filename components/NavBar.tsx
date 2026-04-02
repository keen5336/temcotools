"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { SessionData } from "@/lib/session";

interface NavBarProps {
  session: SessionData;
}

export default function NavBar({ session }: NavBarProps) {
  const router = useRouter();

  async function handleSignOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/signin");
    router.refresh();
  }

  return (
    <nav className="bg-white border-b border-gray-200">
      <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <Link href="/" className="text-sm font-semibold text-gray-900">
            TemcoTools
          </Link>
          <Link href="/tools/rtv-label" className="text-sm text-gray-600 hover:text-gray-900">
            Tools
          </Link>
          {session.role === "admin" && (
            <Link href="/admin/users" className="text-sm text-gray-600 hover:text-gray-900">
              Admin
            </Link>
          )}
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-600">{session.displayName}</span>
          {session.role === "admin" && (
            <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded font-medium">
              Admin
            </span>
          )}
          <button
            onClick={handleSignOut}
            className="text-sm text-gray-500 hover:text-gray-900"
          >
            Sign out
          </button>
        </div>
      </div>
    </nav>
  );
}
