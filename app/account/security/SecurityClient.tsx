"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import MfaClient from "./MfaClient";

type SessionRow = { id: string; deviceLabel: string; createdAt: string; lastActivityAt: string; expiresAt: string; revokedAt: string | null; lockedAt: string | null };
async function command(action: string, input?: unknown) {
  const response = await fetch("/api/account/security", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, input }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Account action failed.");
  return data;
}

export function PasswordConfirmation() {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return <form className="space-y-2" onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setMessage("");
    try { await command("reauthenticate", { password }); setPassword(""); setMessage("Password confirmed. Privileged actions also require a recent authenticator or recovery-code confirmation in Account security."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Confirmation failed."); }
    finally { setBusy(false); }
  }}><label className="block">Confirm your password<input className="input input-bordered w-full mt-1" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label><button className="btn btn-primary w-full sm:w-auto" disabled={busy}>{busy ? "Confirming…" : "Confirm password"}</button><Link href="/account/security" className="link block">Authenticator confirmation and account security</Link>{message && <p role="status" className="text-sm">{message}</p>}</form>;
}

export default function SecurityClient() {
  const router = useRouter();
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [currentId, setCurrentId] = useState("");
  const [error, setError] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => {
    const response = await fetch("/api/account/security", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load sessions.");
    setRows(data.sessions); setCurrentId(data.currentSessionId);
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => { void reload().catch((error) => setError(error.message)); }, 0); return () => clearTimeout(timer); }, [reload]);
  const act = async (action: string, input?: unknown) => {
    setBusy(true); setError("");
    try {
      const result = await command(action, input);
      if (action === "lock" || result.signInRequired || result.current) { router.push("/signin"); router.refresh(); }
      else await reload();
    } catch (error) { setError(error instanceof Error ? error.message : "Action failed."); }
    finally { setBusy(false); }
  };
  return <div className="space-y-4">
    {error && <p role="alert" className="alert alert-error">{error}</p>}
    <section className="card bg-base-100 border border-base-300"><div className="card-body"><PasswordConfirmation /></div></section>
    <MfaClient />
    <section className="card bg-base-100 border border-base-300"><div className="card-body space-y-3"><h2 className="card-title">This scanner or phone</h2><p>Sessions expire after 30 minutes without acknowledged user activity, with a 12-hour absolute limit. Background data refresh and relay leases do not keep them unlocked.</p><button className="btn btn-warning w-full" disabled={busy} onClick={() => void act("lock")}>Lock / switch user</button><Link className="link" href="/">Return to warehouse</Link></div></section>
    <section className="card bg-base-100 border border-base-300"><form className="card-body space-y-3" onSubmit={(event) => { event.preventDefault(); void act("change-password", { currentPassword, newPassword }); }}><h2 className="card-title">Change password</h2><label>Current password<input className="input input-bordered w-full mt-1" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label><label>New password or passphrase<input className="input input-bordered w-full mt-1" type="password" minLength={15} maxLength={512} autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label><p className="text-sm">15–256 characters. Spaces, Unicode and password managers work. Changing it revokes all existing sessions and requires sign-in.</p><button className="btn btn-primary" disabled={busy}>Change password</button></form></section>
    <section className="space-y-3"><h2 className="text-xl font-bold">Your sessions</h2><button className="btn btn-outline w-full" disabled={busy} onClick={() => void act("revoke-other-sessions")}>Revoke all other sessions</button>{rows.map((row) => <article key={row.id} className="rounded-box bg-base-100 border border-base-300 p-4 space-y-2"><strong>{row.deviceLabel}{row.id === currentId ? " · This session" : ""}</strong><p className="text-sm">Last activity {new Date(row.lastActivityAt).toLocaleString()}<br />Expires {new Date(row.expiresAt).toLocaleString()}</p><p>{row.revokedAt ? "Revoked" : row.lockedAt ? "Locked" : "Active or idle"}</p><button className="btn btn-outline w-full sm:w-auto" disabled={busy || !!row.revokedAt} onClick={() => void act("revoke-session", { sessionId: row.id })}>Revoke {row.id === currentId ? "this session" : "session"}</button></article>)}</section>
  </div>;
}
