"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

export default function AccountUpdateClient({ initialUsername, returnTo = "/" }: { initialUsername: string; returnTo?: string }) {
  const [username, setUsername] = useState(initialUsername), [code, setCode] = useState("");
  const [password, setPassword] = useState(""), [confirm, setConfirm] = useState("");
  const [deviceName, setDeviceName] = useState("My Zebra / computer");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => {
    const fragment = new URLSearchParams(location.hash.slice(1));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Hydrate the browser-only private fragment and immediately scrub it from the URL.
    if (fragment.get("code")) { setCode(fragment.get("code") || ""); setUsername(fragment.get("username") || initialUsername); history.replaceState(null, "", location.pathname); }
  }, [initialUsername]);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError("");
    if (password !== confirm) { setError("The passwords do not match."); return; }
    setBusy(true);
    try {
      const response = await fetch("/api/auth/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: username.trim(), code: code.trim(), password, deviceName }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The account update could not be confirmed. Try signing in with your new password before requesting a new code.");
      try { localStorage.setItem("temco_last_username", username.trim()); } catch { /* Optional preference. */ }
      setCode(""); setPassword(""); setConfirm(""); location.assign(returnTo);
    } catch (error) { setError(error instanceof Error ? error.message : "Update could not be confirmed. Try signing in with your new password before requesting another code."); }
    finally { setBusy(false); }
  }
  return <div className="space-y-5">
    <p>We’re updating account security. Keep your existing username and history, and choose a password or passphrase of at least <strong>12 characters</strong>.</p>
    <p className="text-sm text-base-content/65">Ask an administrator for a private setup or recovery code. Codes work once and expire after 30 minutes. No email account is required.</p>
    <form onSubmit={submit} className="space-y-4">
      {error && <p role="alert" className="alert alert-error text-sm">{error}</p>}
      <label className="form-control block"><span className="label font-medium">Username</span><input className="input input-bordered w-full" value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" autoCapitalize="none" maxLength={80} required /></label>
      <label className="form-control block"><span className="label font-medium">Setup or recovery code</span><input className="input input-bordered w-full font-mono" value={code} onChange={event => setCode(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={100} required /></label>
      <label className="form-control block"><span className="label font-medium">New password or passphrase</span><input className="input input-bordered w-full" type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} minLength={12} maxLength={256} required /></label>
      <label className="form-control block"><span className="label font-medium">Confirm new password</span><input className="input input-bordered w-full" type="password" autoComplete="new-password" value={confirm} onChange={event => setConfirm(event.target.value)} minLength={12} maxLength={256} required /></label>
      <label className="form-control block"><span className="label font-medium">Device name</span><input className="input input-bordered w-full" value={deviceName} onChange={event => setDeviceName(event.target.value)} maxLength={80} required /></label>
      <p className="text-xs text-base-content/65">Spaces and password-manager paste are supported. Choose something unique; obvious common passwords are rejected. Completing this update permanently disables your old PIN and signs out earlier sessions.</p>
      <button className="btn btn-primary w-full" disabled={busy}>{busy ? "Updating account…" : "Update account & sign in"}</button>
    </form>
    <Link href="/signin" className="link block text-center">Sign in with an updated password</Link>
  </div>;
}
