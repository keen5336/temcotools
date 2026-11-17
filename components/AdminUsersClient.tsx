"use client";

import Link from "next/link";
import UserDevices from "@/components/admin-UserDevices";
import { useCallback, useEffect, useState } from "react";

type User = { id: string; username: string; displayName: string; role: "admin" | "manager" | "user"; isActive: boolean; authVersion: number; passwordEnrolledAt: string | null; legacyDisabledAt: string | null; lastLoginAt: string | null; _count: { authSessions: number } };
type Data = { users: User[]; legacyLoginEnabled: boolean };
export default function AdminUsersClient() {
  const [data, setData] = useState<Data | null>(null), [search, setSearch] = useState("");
  const [message, setMessage] = useState(""), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const [create, setCreate] = useState({ username: "", displayName: "", role: "user" });
  const [edit, setEdit] = useState<User | null>(null);
  const [reason, setReason] = useState("");
  const [issued, setIssued] = useState<{ username: string; code: string; expiresAt: string } | null>(null);
  const load = useCallback(async () => {
    const response = await fetch(`/api/admin/users?search=${encodeURIComponent(search)}`, { cache: "no-store" });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || "Unable to load users.");
    setData(result); setUncertain(false);
  }, [search]);
  useEffect(() => { const timer = setTimeout(() => { void load().catch(error => setMessage(error.message)); }, 250); return () => clearTimeout(timer); }, [load]);
  async function send(url: string, body: unknown, method = "POST") {
    setBusy(true); setMessage(""); let response: Response | undefined;
    try {
      response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || "The change could not be confirmed.");
      // A confirmed write (especially self-recovery) can end this admin's
      // session. Keep its one-time code even when the follow-up read fails.
      try { await load(); }
      catch { setUncertain(true); setMessage("Change confirmed. Reload the user list or sign in again before another change. Preserve any displayed code."); }
      return result;
    } catch (error) {
      if (!response || response.ok || response.status >= 500) { setUncertain(true); setMessage("The result could not be confirmed. Reload current users before another change. A lost code must be explicitly replaced."); }
      else setMessage(error instanceof Error ? error.message : "Change failed.");
      return null;
    } finally { setBusy(false); }
  }
  async function issue(user: User) {
    if (reason.trim().length < 5) { setMessage("Enter a reason before issuing a setup or recovery code."); return; }
    setIssued(null);
    const result = await send("/api/admin/account-codes", { userId: user.id, purpose: user.passwordEnrolledAt ? "reset" : "enroll", operationId: crypto.randomUUID(), reason });
    if (result?.code) { setIssued({ username: user.username, code: result.code, expiresAt: result.expiresAt }); setMessage("Deliver the code privately to the verified person. Issuing another code replaces this one."); }
    else if (result) setMessage("That code was already issued and cannot be displayed again. Explicitly issue a replacement if it was lost.");
  }
  const disabled = busy || uncertain;
  return <div className="space-y-6">
    <div className="flex flex-wrap gap-3"><Link href="/account/security" className="btn btn-sm btn-outline">Account security & devices</Link><button className="btn btn-sm" disabled={busy} onClick={() => { setIssued(null); void load().then(() => setMessage("Current accounts loaded.")).catch(error => setMessage(error.message)); }}>Reload current users</button></div>
    {message && <p role="status" className="alert alert-info">{message}</p>}
    <section className="card bg-base-100 border border-base-300"><div className="card-body gap-3"><h2 className="card-title">Account migration</h2><p className="text-sm">Old PINs can open only the update flow. After a person updates their account, their old PIN remains disabled even if this switch is turned back on.</p><label className="flex items-center gap-3"><input className="toggle toggle-primary" type="checkbox" checked={data?.legacyLoginEnabled || false} disabled={!data || disabled} onChange={event => void send("/api/admin/auth-policy", { legacyLoginEnabled: event.target.checked })} /><span>Allow legacy PIN entry for accounts awaiting migration</span></label><p className="text-sm">Showing {data?.users.filter(user => !!user.passwordEnrolledAt).length || 0} upgraded and {data?.users.filter(user => !user.passwordEnrolledAt).length || 0} awaiting setup/recovery in this view. Clearing the search shows all accounts.</p></div></section>
    <section className="card bg-base-100 border border-base-300"><div className="card-body gap-3"><h2 className="card-title">Create account</h2><form className="grid sm:grid-cols-4 gap-3" onSubmit={event => { event.preventDefault(); void send("/api/admin/users", create).then(result => { if (result) { setCreate({ username: "", displayName: "", role: "user" }); setMessage("Account created. Issue a setup code separately when the person is ready."); } }); }}><input aria-label="New username" className="input input-bordered w-full" placeholder="Username" autoCapitalize="none" required maxLength={80} value={create.username} onChange={event => setCreate({ ...create, username: event.target.value })} /><input aria-label="New display name" className="input input-bordered w-full" placeholder="Display name" required maxLength={100} value={create.displayName} onChange={event => setCreate({ ...create, displayName: event.target.value })} /><select aria-label="New account role" className="select select-bordered w-full" value={create.role} onChange={event => setCreate({ ...create, role: event.target.value })}>{["user","manager","admin"].map(role => <option key={role}>{role}</option>)}</select><button className="btn btn-primary" disabled={disabled}>Create account</button></form></div></section>
    <section className="card bg-base-100 border border-base-300"><div className="card-body gap-4"><h2 className="card-title">Users and setup codes</h2><label className="block">Search<input className="input input-bordered w-full mt-1" value={search} onChange={event => setSearch(event.target.value)} maxLength={80} /></label><label className="block">Reason for setup/recovery code<input className="input input-bordered w-full mt-1" value={reason} onChange={event => setReason(event.target.value)} placeholder="Example: verified staff member during login migration" maxLength={300} /></label><p className="text-sm text-base-content/65">Setup codes expire after 30 minutes and work once. Starting password recovery signs the person out and disables their current password until they finish recovery.</p>
      <div className="overflow-x-auto"><table className="table"><thead><tr><th>Person</th><th>Access</th><th>Login status</th><th>Devices</th><th>Actions</th></tr></thead><tbody>{data?.users.map(user => <tr key={user.id}><td><strong>{user.displayName}</strong><div>{user.username}</div></td><td>{user.role} · {user.isActive ? "active" : "inactive"}</td><td>{user.passwordEnrolledAt ? "Upgraded · old PIN disabled" : user.legacyDisabledAt ? "Setup/recovery code required" : "Awaiting PIN migration"}</td><td>{user._count.authSessions}</td><td><div className="flex flex-wrap gap-2"><button className="btn btn-sm btn-outline" disabled={disabled} onClick={() => setEdit(user)}>Edit</button><button className="btn btn-sm btn-outline" disabled={disabled || !user.isActive} onClick={() => void issue(user)}>{user.passwordEnrolledAt ? "Start password recovery" : "Issue / replace setup code"}</button><button className="btn btn-sm btn-ghost" disabled={disabled} onClick={() => void send(`/api/admin/users/${user.id}`, { expectedAuthVersion: user.authVersion, revokeSessions: true }, "PATCH")}>Sign out devices</button></div></td></tr>)}</tbody></table></div>
    </div></section>
    {issued && <section className="card bg-base-100 border border-info"><div className="card-body gap-3"><h2 className="card-title">Private code for {issued.username}</h2><p className="break-all font-mono select-all">{issued.code}</p><p>Expires {new Date(issued.expiresAt).toLocaleString()}. Verify the person before handing it over.</p><div className="flex flex-wrap gap-3"><button className="btn btn-primary" onClick={async () => { const fragment = new URLSearchParams({ username: issued.username, code: issued.code }); try { await navigator.clipboard.writeText(`${location.origin}/account/update#${fragment}`); setMessage("Private setup link copied. The code is in the fragment, not a server query string."); } catch { setMessage("Clipboard unavailable. Select and privately deliver the code above."); } }}>Copy private setup link</button><button className="btn btn-outline" onClick={() => setIssued(null)}>Clear displayed code</button></div></div></section>}
    {edit && <section className="card bg-base-100 border border-base-300"><form className="card-body gap-3" onSubmit={event => { event.preventDefault(); void send(`/api/admin/users/${edit.id}`, { expectedAuthVersion: edit.authVersion, username: edit.username, displayName: edit.displayName, role: edit.role, isActive: edit.isActive }, "PATCH").then(result => { if (result) setEdit(null); }); }}><h2 className="card-title">Edit account</h2><UserDevices key={edit.id} userId={edit.id} onChange={() => { void load().catch(error => setMessage(error.message)); }} /><label>Username<input className="input input-bordered w-full mt-1" value={edit.username} onChange={event => setEdit({ ...edit, username: event.target.value })} maxLength={80} required /></label><label>Display name<input className="input input-bordered w-full mt-1" value={edit.displayName} onChange={event => setEdit({ ...edit, displayName: event.target.value })} maxLength={100} required /></label><label>Role<select className="select select-bordered w-full mt-1" value={edit.role} onChange={event => setEdit({ ...edit, role: event.target.value as User["role"] })}>{["user","manager","admin"].map(role => <option key={role}>{role}</option>)}</select></label><label className="flex items-center gap-3"><input className="checkbox" type="checkbox" checked={edit.isActive} onChange={event => setEdit({ ...edit, isActive: event.target.checked })} />Active account</label><p className="text-sm">Changes to username, role or active status sign out existing sessions. Passwords are set by the person using a code.</p><div className="flex gap-3"><button className="btn btn-primary" disabled={disabled}>Save account</button><button type="button" className="btn btn-outline" onClick={() => setEdit(null)}>Cancel</button></div></form></section>}
  </div>;
}
