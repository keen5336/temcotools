"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CAPABILITIES, type Capability } from "@/lib/auth/principal";
import { PasswordConfirmation } from "@/app/account/security/SecurityClient";

type Bundle = { fingerprint: string; id: string; name: string; description: string; capabilities: Capability[]; isSystem: boolean };
type User = { id: string; authVersion: number; username: string; displayName: string; role: "admin" | "manager" | "user"; isPlatformAdmin: boolean; isActive: boolean; passwordChangedAt: string | null; roleBundles: Array<{ bundle: { id: string; name: string; capabilities: Capability[] } }> };
type Audit = { id: string; action: string; actorUserId: string | null; targetUserId: string | null; reason: string | null; createdAt: string };
class AdminRequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function jsonRequest(url: string, method = "GET", body?: unknown) {
  const response = await fetch(url, { method, cache: "no-store", headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new AdminRequestError(data.error || "Account administration failed.", response.status);
  return data;
}

export default function AdminUsersClient() {
  const router = useRouter();
  const [users, setUsers] = useState<User[]>([]);
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [search, setSearch] = useState("");
  const [loadedSearch, setLoadedSearch] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [create, setCreate] = useState({ username: "", displayName: "", role: "user" });
  const [edit, setEdit] = useState<User | null>(null);
  const [editBundleIds, setEditBundleIds] = useState<string[]>([]);
  const [recoveryUser, setRecoveryUser] = useState<User | null>(null);
  const [resetFactor, setResetFactor] = useState(false);
  const [reason, setReason] = useState("");
  const [issued, setIssued] = useState<{ token: string; expiresAt: string } | null>(null);
  const [bundleId, setBundleId] = useState<string | undefined>();
  const [bundleFingerprint, setBundleFingerprint] = useState<string | undefined>();
  const [bundleMessage, setBundleMessage] = useState("");
  const [bundleName, setBundleName] = useState("");
  const [bundleDescription, setBundleDescription] = useState("");
  const [caps, setCaps] = useState<Capability[]>([]);
  const reads = useRef(0), mutation = useRef(0), inFlight = useRef(false), alive = useRef(false), currentSearch = useRef("");
  const contexts = useRef({ create: 0, edit: 0, recovery: 0, bundle: 0 });
  const reload = useCallback(async () => {
    const generation = ++reads.current, query = currentSearch.current;
    try {
      const [people, roles, events] = await Promise.all([jsonRequest(`/api/admin/users?search=${encodeURIComponent(query)}`), jsonRequest("/api/admin/users/bundles"), jsonRequest("/api/admin/users/recovery")]);
      if (!alive.current || generation !== reads.current || query !== currentSearch.current) return;
      setUsers(people); setBundles(roles); setAudit(events); setLoadedSearch(query);
    } catch (error) { if (alive.current && generation === reads.current && query === currentSearch.current) throw error; }
  }, []);
  const failure = useCallback((error: unknown) => {
    if (!alive.current) return;
    if (error instanceof AdminRequestError && error.status === 401) { router.push("/signin"); router.refresh(); }
    else setMessage(error instanceof Error ? error.message : "Account administration failed.");
  }, [router]);
  useEffect(() => { const readCounter = reads, writeCounter = mutation; alive.current = true; return () => { alive.current = false; readCounter.current++; writeCounter.current++; }; }, []);
  useEffect(() => { const timer = window.setTimeout(() => { void reload().catch(failure); }, 250); return () => clearTimeout(timer); }, [search, reload, failure]);
  const run = async (action: (current: () => boolean) => Promise<void>, context?: keyof typeof contexts.current) => {
    if (inFlight.current) return;
    inFlight.current = true; reads.current++;
    const generation = ++mutation.current, scope = context ? contexts.current[context] : null;
    const current = () => alive.current && generation === mutation.current && (!context || scope === contexts.current[context]);
    setBusy(true); setMessage("");
    if (context === "recovery") setIssued(null);
    if (context === "bundle") setBundleMessage("");
    try {
      await action(current);
      if (current()) try { await reload(); } catch (error) {
        if (error instanceof AdminRequestError && error.status === 401) failure(error);
        else if (current()) setMessage("Account action completed. Refresh current people before another change; the follow-up read failed.");
      }
    } catch (error) {
      if (current()) {
        if (context === "bundle" && error instanceof AdminRequestError && error.status === 409) {
          setBundleMessage(`${error.message} Reopen the current custom bundle below before editing again; the old form was not saved.`);
          await reload().catch(failure);
        } else {
          failure(error);
          if (error instanceof AdminRequestError && error.status === 409) {
            setMessage(`${error.message} Close the old form and reopen its current person card before editing again.`);
            await reload().catch(failure);
          }
        }
      }
    }
    finally { inFlight.current = false; if (alive.current && generation === mutation.current) setBusy(false); }
  };
  return <div className="space-y-5 min-w-0 [overflow-wrap:anywhere]"><fieldset disabled={busy} className="contents">
    <section className="card bg-base-100 border border-base-300"><div className="card-body"><PasswordConfirmation /><p className="text-sm">Account, access and recovery changes require password and second-factor confirmation within 10 minutes. Existing sessions are revoked when access changes.</p></div></section>
    <p className="alert">Warehouse access is managed in Warehouse Settings. Legacy role labels and bundles do not grant platform administration. Platform admin status is separate.</p>{message && <p role="status" className="alert">{message}</p>}
    <label className="block">Find a person<input className="input input-bordered w-full mt-1" value={search} onChange={(event) => { currentSearch.current = event.target.value; reads.current++; setSearch(event.target.value); }} placeholder="Username or display name" /></label>
    <button className="btn btn-outline w-full sm:w-auto" disabled={busy} onClick={() => { void reload().catch(failure); }}>Refresh people and access</button>
    {loadedSearch !== search && <p role="status">Loading current matching people…</p>}
    <details className="rounded-box border border-base-300 bg-base-100 p-4"><summary className="font-bold cursor-pointer">Create account</summary><form className="space-y-3 mt-3" onSubmit={(event) => { event.preventDefault(); void run(async (current) => {
      await jsonRequest("/api/admin/users", "POST", create); if (current()) { setCreate({ username: "", displayName: "", role: "user" }); setMessage("Account created. Verify the person's identity, then issue an enrollment code."); }
    }, "create"); }}><label className="block">Username<input className="input input-bordered w-full mt-1" value={create.username} onChange={(event) => setCreate({ ...create, username: event.target.value })} maxLength={80} required /></label><label className="block">Display name<input className="input input-bordered w-full mt-1" value={create.displayName} onChange={(event) => setCreate({ ...create, displayName: event.target.value })} maxLength={100} required /></label><label className="block">Initial warehouse bundle<select className="select select-bordered w-full mt-1" value={create.role} onChange={(event) => setCreate({ ...create, role: event.target.value })}><option value="user">Warehouse operator</option><option value="manager">Operations manager</option><option value="admin">Legacy admin / site manager</option></select></label><button className="btn btn-primary w-full" disabled={busy}>Create account for assisted enrollment</button></form></details>
    <section className="space-y-3">{(loadedSearch === search ? users : []).map((user) => <article key={user.id} className="rounded-box border border-base-300 bg-base-100 p-4 space-y-3 min-w-0"><div><h2 className="font-bold text-lg">{user.displayName}</h2><p>{user.username} · {user.isActive ? "Active" : "Inactive"} · {user.passwordChangedAt ? "Password enrolled" : "Needs password enrollment"}</p><p className="text-sm">Legacy compatibility bundles: {user.roleBundles.map(({ bundle }) => bundle.name).join(", ") || "None"}</p></div><div className="grid grid-cols-1 sm:grid-cols-2 gap-2"><button className="btn btn-outline" disabled={busy} onClick={() => { contexts.current.edit++; setEdit(user); setEditBundleIds(user.roleBundles.map(({ bundle }) => bundle.id)); }}>Edit access</button><button className="btn btn-outline" disabled={busy || !user.isActive} onClick={() => { contexts.current.recovery++; setRecoveryUser(user); setResetFactor(false); setReason(""); setIssued(null); }}>{user.passwordChangedAt ? "Issue recovery code" : "Issue enrollment code"}</button><button className="btn btn-outline" disabled={busy} onClick={() => void run(async (current) => { await jsonRequest(`/api/admin/users/${encodeURIComponent(user.id)}`, "PATCH", { expectedAuthVersion: user.authVersion, revokeSessions: true }); if (current()) setMessage("Sessions revoked."); })}>Revoke all sessions</button><button className="btn btn-warning btn-outline" disabled={busy || !user.isActive} onClick={() => { contexts.current.recovery++; setRecoveryUser(user); setResetFactor(true); setReason(""); setIssued(null); }}>Recover lost authenticator</button></div></article>)}</section>
    {edit && <section className="rounded-box border-2 border-primary bg-base-100 p-4 space-y-3"><h2 className="font-bold">Edit {edit.username}</h2><form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void run(async (current) => {
      await jsonRequest(`/api/admin/users/${encodeURIComponent(edit.id)}`, "PATCH", { expectedAuthVersion: edit.authVersion, username: edit.username, displayName: edit.displayName, role: edit.role, isActive: edit.isActive, isPlatformAdmin: edit.isPlatformAdmin, bundleIds: editBundleIds }); if (current()) { setEdit(null); setMessage("Account updated. Previous sessions revoked."); }
    }, "edit"); }}><label className="block">Username<input className="input input-bordered w-full mt-1" value={edit.username} onChange={(event) => setEdit({ ...edit, username: event.target.value })} required /></label><label className="block">Display name<input className="input input-bordered w-full mt-1" value={edit.displayName} onChange={(event) => setEdit({ ...edit, displayName: event.target.value })} required /></label><label className="block">Legacy role label<select className="select select-bordered w-full mt-1" value={edit.role} onChange={(event) => { const role = event.target.value as User["role"]; setEdit({ ...edit, role }); setEditBundleIds([`legacy-${role}`]); }}><option value="user">User</option><option value="manager">Manager</option><option value="admin">Legacy admin</option></select></label><label className="flex gap-2 items-center"><input type="checkbox" className="checkbox" checked={edit.isActive} onChange={(event) => setEdit({ ...edit, isActive: event.target.checked })} />Active account</label><label className="flex gap-2 items-center"><input type="checkbox" className="checkbox" checked={edit.isPlatformAdmin} onChange={event => setEdit({ ...edit, isPlatformAdmin: event.target.checked })} />Platform administrator (all warehouses)</label><fieldset className="space-y-2"><legend className="font-bold mb-2">Legacy compatibility bundles</legend>{bundles.map((bundle) => <label key={bundle.id} className="flex gap-2 items-start"><input className="checkbox shrink-0" type="checkbox" checked={editBundleIds.includes(bundle.id)} onChange={(event) => setEditBundleIds(event.target.checked ? [...editBundleIds, bundle.id] : editBundleIds.filter((id) => id !== bundle.id))} /><span className="min-w-0">{bundle.name}<small className="block opacity-70">{bundle.description}</small></span></label>)}</fieldset><div className="grid grid-cols-2 gap-2"><button className="btn btn-primary" disabled={busy}>Save access</button><button type="button" className="btn" disabled={busy} onClick={() => { contexts.current.edit++; setEdit(null); }}>Cancel</button></div></form></section>}
    {recoveryUser && <section className="rounded-box border-2 border-warning bg-base-100 p-4 space-y-3"><h2 className="font-bold">{resetFactor ? "Lost authenticator recovery" : recoveryUser.passwordChangedAt ? "Recovery" : "Enrollment"} for {recoveryUser.displayName}</h2><p>Verify this person&#39;s identity. Privately deliver the code; never place it in shared notes, chat or public files.</p>{resetFactor && <p className="font-semibold">This revokes the person&#39;s password, authenticator, recovery codes, sessions and connected clients. They must set a new password and enroll a new authenticator. Keep another usable administrator.</p>}<label className="block">Verification reason<input className="input input-bordered w-full mt-1" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={300} /></label><button className="btn btn-warning w-full" disabled={busy || reason.trim().length < 5} onClick={() => void run(async (current) => { const issued = await jsonRequest(resetFactor ? "/api/admin/users/factor-reset" : "/api/admin/users/recovery", "POST", resetFactor ? { userId: recoveryUser.id, reason } : { userId: recoveryUser.id, purpose: recoveryUser.passwordChangedAt ? "reset" : "enroll", reason }); if (current()) setIssued(issued); }, "recovery")}>Issue one-use code</button>{issued && <div className="space-y-2"><textarea className="textarea textarea-bordered font-mono w-full break-all" readOnly aria-label="One-use recovery code" value={issued.token} /><p>Shown only here. Expires {new Date(issued.expiresAt).toLocaleString()}. The person sets their own password at Sign in → Enrollment or recovery.</p></div>}<button className="btn w-full" disabled={busy} onClick={() => { contexts.current.recovery++; setRecoveryUser(null); setResetFactor(false); setIssued(null); }}>Close and clear code</button></section>}
    <details className="rounded-box border border-base-300 bg-base-100 p-4"><summary className="font-bold cursor-pointer">Manage capability bundles</summary><div className="space-y-3 mt-3">{bundles.map((bundle) => <div key={bundle.id} className="border-b border-base-300 py-2"><strong>{bundle.name}</strong><p className="text-xs break-all">{bundle.capabilities.join(", ")}</p>{!bundle.isSystem && <button className="btn btn-sm mt-2" disabled={busy} onClick={() => { contexts.current.bundle++; setBundleId(bundle.id); setBundleFingerprint(bundle.fingerprint); setBundleMessage(""); setBundleName(bundle.name); setBundleDescription(bundle.description); setCaps(bundle.capabilities); }}>Edit bundle</button>}</div>)}<form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void run(async (current) => { await jsonRequest("/api/admin/users/bundles", "POST", { ...(bundleId ? { id: bundleId, expectedFingerprint: bundleFingerprint } : {}), name: bundleName, description: bundleDescription, capabilities: caps }); if (current()) { setBundleId(undefined); setBundleFingerprint(undefined); setBundleName(""); setBundleDescription(""); setCaps([]); setBundleMessage("Bundle saved; affected sessions revoked."); } }, "bundle"); }}><h3 className="font-bold">{bundleId ? "Edit custom bundle" : "New custom bundle"}</h3>{bundleMessage && <p role="status" className="alert block break-words">{bundleMessage}</p>}<input aria-label="Bundle name" className="input input-bordered w-full" value={bundleName} onChange={(event) => setBundleName(event.target.value)} placeholder="Bundle name" required /><input aria-label="Bundle description" className="input input-bordered w-full" value={bundleDescription} onChange={(event) => setBundleDescription(event.target.value)} placeholder="Purpose" />{CAPABILITIES.map((cap) => <label key={cap} className="flex gap-2 items-center"><input type="checkbox" className="checkbox" checked={caps.includes(cap)} onChange={(event) => setCaps(event.target.checked ? [...caps, cap] : caps.filter((item) => item !== cap))} /><span>{cap}</span></label>)}<button className="btn btn-primary w-full" disabled={busy || Boolean(bundleId && !bundleFingerprint)}>Save custom bundle</button><button type="button" className="btn w-full" disabled={busy} onClick={() => { contexts.current.bundle++; setBundleMessage(""); setBundleId(undefined); setBundleFingerprint(undefined); setBundleName(""); setBundleDescription(""); setCaps([]); }}>Clear form</button></form></div></details>
    <details className="rounded-box border border-base-300 bg-base-100 p-4"><summary className="font-bold cursor-pointer">Recent account audit</summary><div className="space-y-2 mt-3">{audit.map((row) => <div className="border-b border-base-300 pb-2 text-sm break-all" key={row.id}><strong>{row.action}</strong> · {new Date(row.createdAt).toLocaleString()}<p>Actor {row.actorUserId || "Public recovery"} · Account {row.targetUserId || "Unmatched"}</p>{row.reason && <p>{row.reason}</p>}</div>)}</div></details>
  </fieldset></div>;
}
