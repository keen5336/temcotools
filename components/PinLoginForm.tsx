"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

export default function PinLoginForm({ legacyAllowed }: { legacyAllowed: boolean }) {
  const [username, setUsername] = useState(""), [credential, setCredential] = useState("");
  const [legacy, setLegacy] = useState(false), [deviceName, setDeviceName] = useState("My Zebra / computer");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  // The remembered username lives only in browser storage; hydrate after SSR.
  useEffect(() => {
    try {
      const saved = localStorage.getItem("temco_last_username");
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Sync browser-only storage after hydration.
      if (saved) setUsername(saved);
    } catch { /* Storage is optional; manual sign-in still works. */ }
  }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: username.trim(), deviceName, ...(legacy ? { method: "legacy", pin: credential } : { password: credential }) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Sign-in failed.");
      try { localStorage.setItem("temco_last_username", username.trim()); } catch { /* Optional preference. */ }
      location.assign(result.redirectTo === "/account/update" ? "/account/update" : "/");
    } catch (error) { setError(error instanceof Error ? error.message : "Sign-in could not be confirmed. Try signing in again."); setCredential(""); }
    finally { setBusy(false); }
  }
  return <div className="space-y-4">
    <form onSubmit={submit} className="space-y-4">
      <h2 className="font-semibold">{legacy ? "Update an old PIN account" : "Sign in"}</h2>
      {legacy && <p className="text-sm text-base-content/65">Use your previous username and PIN to start setup. An administrator will give you a private one-use code. After updating, your old PIN stops working.</p>}
      {error && <p role="alert" className="alert alert-error text-sm">{error}</p>}
      <label className="form-control block"><span className="label font-medium">Username</span><input className="input input-bordered w-full" autoComplete="username" autoCapitalize="none" value={username} onChange={event => setUsername(event.target.value)} required maxLength={80} disabled={busy} /></label>
      <label className="form-control block"><span className="label font-medium">{legacy ? "Previous PIN" : "Password or passphrase"}</span><input className="input input-bordered w-full" type="password" inputMode={legacy ? "numeric" : "text"} autoComplete="current-password" value={credential} onChange={event => setCredential(event.target.value)} required maxLength={legacy ? 6 : 256} disabled={busy} /></label>
      <label className="form-control block"><span className="label font-medium">Device name</span><input className="input input-bordered w-full" value={deviceName} onChange={event => setDeviceName(event.target.value)} maxLength={80} required disabled={busy} /></label>
      {!legacy && <p className="text-xs text-base-content/65">Stay signed in on this assigned device for up to 30 days, including across shifts. Sign out on shared devices.</p>}
      <button className="btn btn-primary w-full" disabled={busy}>{busy ? "Signing in…" : legacy ? "Start account update" : "Sign in"}</button>
    </form>
    {legacyAllowed && <button type="button" className="btn btn-ghost btn-sm w-full" disabled={busy} onClick={() => { setLegacy(!legacy); setCredential(""); setError(""); }}>{legacy ? "Use updated password login" : "Use old PIN to update my account"}</button>}
    <Link className="link block text-center text-sm" href="/account/update">Have a setup/recovery code, or need help?</Link>
  </div>;
}
