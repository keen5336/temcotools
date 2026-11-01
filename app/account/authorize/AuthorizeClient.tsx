"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

type Consent = { requestId: string; clientName: string; clientId: string; redirectUri: string; resource: string; scopes: string[]; allowedScopes: string[]; user: { displayName: string; username: string }; expiresAt: string; requiresPrivilegedProof: boolean };
type Grant = { id: string; client: { name: string }; scopes: string[]; expiresAt: string; revokedAt: string | null };
const descriptions: Record<string, string> = {
  "inventory.read": "View warehouse inventory and unit history", "inventory.write": "Import inventory and record observations", "inventory.identify": "Review and correct physical-unit identifier links",
  "workflow.read": "View warehouse work and progress", "workflow.execute": "Execute permitted warehouse workflow actions", "labels.read": "View approved label and printer choices", "labels.print": "Issue labels through authorized connected devices",
  "labels.manage": "Manage printers, label templates and rules", "users.manage": "Administer people, access and account recovery", "files.manage": "Manage shared operational files", "payloads.manage": "Manage and publish external-page payload code", "diagnostics.use": "Use administrative scanner diagnostics", "office.decide": "Decide office cases and handling instructions", "office.authorize_rtv": "Authorize eligible RTV handling",
  "account.self": "Manage your own sessions and connected application grants",
  "dispatch.allocate": "Approve dispatch demand and allocate physical units", "dispatch.signoff": "Sign off verified finals lanes and amendments",
};

export default function AuthorizeClient({ requestId }: { requestId: string }) {
  const [consent, setConsent] = useState<Consent | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingDecision, setPendingDecision] = useState<"approve" | "deny" | null>(null);
  const [topLevel, setTopLevel] = useState(false);
  const feedback = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (message) feedback.current?.focus(); }, [message]);
  const reload = useCallback(async () => {
    const response = await fetch(`/api/oauth-consent${requestId ? `?request=${encodeURIComponent(requestId)}` : ""}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Client request is unavailable.");
    if (requestId) { setConsent(data); setScopes(data.allowedScopes); } else setGrants(data.grants);
  }, [requestId]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setTopLevel(window.self === window.top);
      void reload().catch((error) => setMessage(error.message));
    }, 0);
    return () => clearTimeout(timer);
  }, [reload]);
  const decide = async (decision: "approve" | "deny") => {
    setBusy(true); setPendingDecision(decision); setMessage("");
    try {
      const response = await fetch("/api/oauth-consent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId, decision, scopes }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Authorization failed.");
      setMessage(decision === "approve" ? "Access approved. Returning to your client…" : "Access denied. Returning to your client…");
      window.location.assign(data.redirectTo);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Authorization failed."); setBusy(false); setPendingDecision(null); }
  };
  return <div className="space-y-4">
    {!topLevel && <p role="alert" className="alert alert-warning">Open this authorization page directly in your browser.</p>}
    {consent && <section className="card bg-base-100 border border-base-300"><div className="card-body space-y-3"><h2 className="card-title">Allow {consent.clientName}?</h2><p>Signed in as <strong>{consent.user.displayName}</strong> ({consent.user.username}). This client-defined name does not verify its publisher. Approve only an application you intended to connect.</p><dl className="text-sm space-y-2 break-all"><div><dt className="font-bold">Client ID</dt><dd>{consent.clientId}</dd></div><div><dt className="font-bold">Return address</dt><dd>{consent.redirectUri}</dd></div><div><dt className="font-bold">TemcoTools resource</dt><dd>{consent.resource}</dd></div></dl><fieldset className="space-y-3"><legend className="font-bold mb-2">Requested access</legend>{consent.scopes.map((scope) => <label key={scope} className="flex gap-3 items-start"><input className="checkbox shrink-0" type="checkbox" checked={scopes.includes(scope)} disabled={!consent.allowedScopes.includes(scope) || busy} onChange={(event) => setScopes(event.target.checked ? [...scopes, scope] : scopes.filter((entry) => entry !== scope))} /><span>{descriptions[scope] || scope}<small className="block opacity-60">{scope}{!consent.allowedScopes.includes(scope) ? " · unavailable to your account" : ""}</small></span></label>)}</fieldset>{consent.requiresPrivilegedProof && <p className="text-sm">Privileged scopes require password and second-factor confirmation within 10 minutes. <Link href="/account/security" target="_blank" rel="noopener noreferrer" className="link">Confirm in Account security</Link>, then return here.</p>}<p className="text-sm">Access stays within your current permissions and this signed-in session. Locking, revocation or session expiry ends it. This request expires {new Date(consent.expiresAt).toLocaleTimeString()}.</p><div className="grid grid-cols-1 sm:grid-cols-2 gap-2" aria-busy={busy}><button className="btn btn-primary" disabled={busy || !topLevel || scopes.length === 0} onClick={() => void decide("approve")}>{pendingDecision === "approve" ? "Approving…" : "Approve selected access"}</button><button className="btn btn-outline" disabled={busy || !topLevel} onClick={() => void decide("deny")}>{pendingDecision === "deny" ? "Denying…" : "Deny"}</button></div>{message && <p ref={feedback} role="alert" tabIndex={-1} className="alert break-words">{message}</p>}</div></section>}
    {!requestId && <section className="space-y-3"><h2 className="text-xl font-bold">Your connected applications</h2>{grants.length === 0 && <p>No application grants.</p>}{grants.map((grant) => <article key={grant.id} className="rounded-box bg-base-100 border border-base-300 p-4 space-y-2"><strong>{grant.client.name}</strong><p className="text-sm break-all">{grant.scopes.join(", ")}<br />Expires {new Date(grant.expiresAt).toLocaleString()}</p><button className="btn btn-outline w-full" disabled={busy || !!grant.revokedAt} onClick={() => {
      setBusy(true); setMessage(""); void fetch("/api/oauth-consent", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: grant.id }) }).then(async (response) => { if (!response.ok) throw new Error("Could not revoke this grant."); await reload(); }).catch((error) => setMessage(error.message)).finally(() => setBusy(false));
    }}>{grant.revokedAt ? "Revoked" : "Revoke application access"}</button></article>)}</section>}
    {!consent && message && <p ref={feedback} role="alert" tabIndex={-1} className="alert break-words">{message}</p>}<button className="btn btn-outline w-full" disabled={busy} onClick={() => { void reload().catch((error) => setMessage(error.message)); }}>Refresh request or grants</button><Link href="/account/security" className="link block">Account security</Link>
  </div>;
}
