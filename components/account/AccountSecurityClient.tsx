"use client";
/* eslint-disable @next/next/no-location-assign-relative-destination -- Authentication changes reload the document to discard prior session providers. */

import { useCallback, useEffect, useState } from "react";

type Devices = { currentSessionId: string; sessions: { id: string; deviceName: string; createdAt: string; expiresAt: string }[] };
export default function AccountSecurityClient() {
  const [devices, setDevices] = useState<Devices | null>(null);
  const [password, setPassword] = useState(""), [next, setNext] = useState(""), [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const response = await fetch("/api/account/security", { cache: "no-store" });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || "Unable to load devices."); return result as Devices;
  }, []);
  useEffect(() => { let active = true; void load().then(result => { if (active) setDevices(result); }).catch(error => { if (active) setMessage(error.message); }); return () => { active = false; }; }, [load]);
  async function send(body: Record<string, unknown>) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/account/security", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || "The account change could not be confirmed.");
      setPassword("");
      if (result.current) { location.assign("/signin"); return; }
      if (result.changed) { setNext(""); setConfirm(""); location.assign("/account/security"); return; }
      setDevices(await load()); setMessage(body.action === "reauthenticate" ? "Password confirmed for sensitive changes for 10 minutes. You can return to the tool you were using." : "Device sessions updated.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Change could not be confirmed. Reload current state before trying again."); }
    finally { setBusy(false); }
  }
  return <div className="space-y-6">
    {message && <p role="status" className="alert alert-info">{message}</p>}
    <section className="card bg-base-100 border border-base-300"><div className="card-body gap-4"><h2 className="card-title">Confirm your password</h2><p className="text-sm">You stay signed in across shifts for up to 30 days. Sensitive account and publishing changes require a recent password check.</p><form className="flex flex-wrap gap-3" onSubmit={event => { event.preventDefault(); void send({ action: "reauthenticate", password }); }}><input aria-label="Current password" className="input input-bordered flex-1" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required maxLength={256} /><button className="btn btn-primary" disabled={busy}>Confirm password</button></form></div></section>
    <section className="card bg-base-100 border border-base-300"><div className="card-body gap-4"><h2 className="card-title">Change password</h2><form className="space-y-3" onSubmit={event => { event.preventDefault(); if (next !== confirm) { setMessage("New passwords must match."); return; } void send({ action: "change-password", input: { currentPassword: password, password: next, deviceName: "This device" } }); }}><label className="block">Current password<input className="input input-bordered w-full mt-1" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required maxLength={256} /></label><label className="block">New password or passphrase<input className="input input-bordered w-full mt-1" type="password" autoComplete="new-password" value={next} onChange={event => setNext(event.target.value)} minLength={12} maxLength={256} required /></label><label className="block">Confirm new password<input className="input input-bordered w-full mt-1" type="password" autoComplete="new-password" value={confirm} onChange={event => setConfirm(event.target.value)} minLength={12} maxLength={256} required /></label><button className="btn btn-primary" disabled={busy}>Change password</button></form><p className="text-sm text-base-content/65">Changing your password signs out other devices and ends old API relay connections. This device receives a new session.</p></div></section>
    <section className="card bg-base-100 border border-base-300"><div className="card-body gap-4"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="card-title">Signed-in devices</h2><button className="btn btn-sm btn-outline" disabled={busy} onClick={() => void send({ action: "revoke-others" })}>Sign out other devices</button></div>{devices?.sessions.map(session => <div key={session.id} className="flex flex-wrap justify-between gap-3 border-t border-base-200 pt-3"><div><strong>{session.deviceName}</strong>{session.id === devices.currentSessionId ? " · this device" : ""}<p className="text-sm">Signed in {new Date(session.createdAt).toLocaleString()} · expires {new Date(session.expiresAt).toLocaleString()}</p></div><button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void send({ action: "revoke-session", sessionId: session.id })}>Sign out</button></div>)}</div></section>
  </div>;
}
