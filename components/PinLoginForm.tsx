"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";

// Keep the old import name while replacing public PIN authentication.
export default function PinLoginForm({ returnTo = "/" }: { returnTo?: string }) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [deviceLabel, setDeviceLabel] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return <form className="space-y-4" onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: username.trim(), password, deviceLabel: deviceLabel.trim() || "Browser" }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Sign-in failed.");
      setPassword(""); router.push(returnTo); router.refresh();
    } catch (error) { setPassword(""); setError(error instanceof Error ? error.message : "Sign-in failed."); }
    finally { setBusy(false); }
  }}>
    {error && <p role="alert" className="alert alert-error text-sm">{error}</p>}
    <label className="block">Username<input name="username" className="input input-bordered w-full mt-1" autoComplete="username" autoCapitalize="none" autoCorrect="off" value={username} onChange={(event) => setUsername(event.target.value)} required maxLength={80} disabled={busy} /></label>
    <label className="block">Password or passphrase<input name="password" type="password" className="input input-bordered w-full mt-1" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required maxLength={512} disabled={busy} /></label>
    <label className="block">Device name <span className="text-sm opacity-60">(optional)</span><input className="input input-bordered w-full mt-1" placeholder="Zebra 3 or Office phone" value={deviceLabel} onChange={(event) => setDeviceLabel(event.target.value)} maxLength={80} disabled={busy} /></label>
    <button className="btn btn-primary w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    <Link href="/signin/recovery" className="link block text-center">First password enrollment or account recovery</Link>
  </form>;
}
