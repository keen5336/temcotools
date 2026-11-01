"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Capability } from "@/lib/auth/principal";
import type { ConnectedClientSetup } from "@/lib/application/client-setup";

async function request(path: string, init?: RequestInit) {
  const response = await fetch(path, { cache: "no-store", ...init });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Client permissions are unavailable. Sign in again if your session ended.");
  return data;
}
export default function AccessGrantsClient() {
  const [data, setData] = useState<ConnectedClientSetup | null>(null), [name, setName] = useState("My MCP client"), [scopes, setScopes] = useState<Capability[]>([]), [token, setToken] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false), [copyMessage, setCopyMessage] = useState("");
  const alive = useRef(false), reads = useRef(0), actor = useRef<string | null>(null), initialized = useRef(false), inFlight = useRef(false);
  const endpoint = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => {
    const sequence = ++reads.current;
    let value: ConnectedClientSetup;
    try { value = await request("/api/access-grants/setup"); } catch (failure) { if (alive.current && sequence === reads.current) throw failure; return; }
    if (!alive.current || sequence !== reads.current) return;
    if (actor.current && actor.current !== value.actorUserId) { setToken(""); setNotice(""); initialized.current = false; }
    actor.current = value.actorUserId;
    const hadSelection = initialized.current;
    setScopes(previous => hadSelection ? previous.filter(scope => value.availableReadScopes.includes(scope)) : value.availableReadScopes);
    initialized.current = true; setData(value);
  }, []);
  useEffect(() => { alive.current = true; const timer = window.setTimeout(() => { void refresh().catch(failure => { if (alive.current) setError(failure.message); }); }, 0); return () => { alive.current = false; window.clearTimeout(timer); }; }, [refresh]);
  async function mutate(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; reads.current++; setBusy(true); setError(""); setNotice("");
    try { await action(); await refresh(); }
    catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : "Client action failed. Inspect recorded permissions before repeating it."); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  async function create() {
    setToken("");
    await mutate(async () => {
      const result = await request("/api/access-grants", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientName: name, scopes, lifetimeMinutes: 30 }) });
      if (alive.current) { setToken(result.token); setNotice("Private read-only grant created. Its secret is shown once on this page."); }
    });
  }
  async function revoke(id: string, kind: "stdio" | "oauth") {
    await mutate(async () => { await request(`/api/access-grants?${new URLSearchParams({ id, kind })}`, { method: "DELETE" }); if (alive.current) { setToken(""); setNotice("Client permission revoked. This does not undo actions already completed."); } });
  }
  async function copyEndpoint() {
    if (!data?.connection.mcpUrl) return;
    try { await navigator.clipboard.writeText(data.connection.mcpUrl); setCopyMessage("MCP server URL copied."); }
    catch { endpoint.current?.focus(); endpoint.current?.select(); setCopyMessage("Select the URL above and copy it manually; automatic clipboard access is unavailable."); }
  }
  const readAt = data ? Date.parse(data.asOf) : 0;
  const expiry = (value: string | Date) => new Date(String(value)).toLocaleString();
  return <div className="space-y-5 min-w-0 [overflow-wrap:anywhere]">
    <div className="flex flex-wrap gap-3"><Link className="link py-2" href="/account/security">Account security / required password and authenticator checks</Link><button className="btn btn-outline min-h-11" disabled={busy} onClick={() => { setError(""); void refresh().catch(failure => setError(failure.message)); }}>Refresh client permissions</button></div>
    {error && <p role="alert" className="alert alert-error block break-words">{error}</p>}{notice && <p role="status" className="alert block break-words">{notice}</p>}
    <section className="rounded-xl border border-base-300 bg-base-100 p-4 space-y-3 min-w-0"><h2 className="text-xl font-semibold">Remote MCP setup</h2>
      {!data ? <p>Loading configured setup and your permissions…</p> : <><p>{data.connection.notice}</p>{data.connection.mcpUrl && <><label className="block">Remote MCP server URL<input ref={endpoint} aria-label="Remote MCP server URL" className="input input-bordered w-full mt-1 font-mono text-sm" readOnly value={data.connection.mcpUrl} onFocus={event => event.currentTarget.select()} /></label><button className="btn btn-outline min-h-11 w-full sm:w-auto" onClick={() => void copyEndpoint()}>Copy MCP server URL</button>{copyMessage && <p role="status" className="text-sm">{copyMessage}</p>}<ol className="list-decimal pl-5 space-y-2"><li>In your MCP client, add a custom server using this exact URL with Streamable HTTP and OAuth sign-in. Do not put a password or token in the URL.</li><li>Start authorization in that client. Sign in to TemcoTools yourself and complete any required password/authenticator checks.</li><li>Review the client name and requested permissions. Approve only the minimum scopes needed; sensitive scopes require recent password and authenticator confirmation. A client cannot approve itself.</li></ol></>}<p className="text-sm">A client must support this OAuth connection and reach both the MCP endpoint and its TemcoTools authorization page. This page does not provision a public address, change networking, or test a connection.</p></>}
    </section>
    <section className="rounded-xl border border-base-300 bg-base-100 p-4 space-y-3 min-w-0"><h2 className="text-xl font-semibold">Your remote OAuth permissions</h2><p className="text-sm">These records show granted permissions, not whether a client is online. No access or refresh token is displayed here.</p>{data && data.oauthGrants.length >= 100 && <p className="text-sm">Showing the 100 most recent OAuth records. Ending issuing sessions in Account security also stops their bound clients.</p>}{data?.oauthGrants.length === 0 && <p>No remote OAuth grants are recorded for your account.</p>}<ul className="space-y-3">{data?.oauthGrants.map(grant => <li className="rounded-xl border border-base-300 p-3 space-y-2 min-w-0" key={grant.id}><strong>{grant.clientName}</strong><p className="text-sm">{grant.scopes.join(", ")}</p><p className="text-sm">{grant.resource ?? "Stored resource URL is unavailable for safe display."}</p><p className="text-sm">Expires {expiry(grant.expiresAt)} · {grant.revokedAt ? "Revoked" : Date.parse(String(grant.expiresAt)) <= readAt ? "Expired" : "Not revoked; session-bound"}</p>{!grant.revokedAt && <button className="btn btn-outline min-h-11 w-full sm:w-auto" disabled={busy} onClick={() => void revoke(grant.id, "oauth")}>Revoke remote client</button>}</li>)}</ul></section>
    <section className="rounded-xl border border-base-300 bg-base-100 p-4 space-y-3 min-w-0"><h2 className="text-xl font-semibold">Private stdio / development grant</h2><p>Use this separate flow for a trusted local stdio client. Grants expire after 30 minutes and stay bound to your current individual session and permissions.</p><label className="block">Client name<input className="input input-bordered w-full mt-1" value={name} maxLength={80} disabled={busy} onChange={event => setName(event.target.value)} /></label><fieldset disabled={busy} className="space-y-2 min-w-0"><legend className="font-semibold mb-2">Minimum read-only scopes</legend>{data?.availableReadScopes.map(scope => <label key={scope} className="flex gap-3 items-center min-h-11"><input className="checkbox shrink-0" type="checkbox" checked={scopes.includes(scope)} onChange={event => setScopes(previous => event.target.checked ? [...previous, scope] : previous.filter(value => value !== scope))} /><span>{scope}</span></label>)}{data && !data.availableReadScopes.length && <p>Your current permissions do not include these warehouse read scopes.</p>}</fieldset><button className="btn btn-primary min-h-11 w-full sm:w-auto" disabled={busy || !data || !name.trim() || !scopes.length} onClick={() => void create()}>Create read-only MCP grant</button>
      {token && <div className="rounded-xl border border-warning p-3 space-y-2"><p>Copy this secret into the client&apos;s private TEMCO_MCP_TOKEN setting. It is shown once locally. Never put it in a URL, shared message or repository.</p><textarea aria-label="New client token" className="textarea textarea-bordered w-full font-mono min-h-24" readOnly value={token} /><button className="btn btn-sm min-h-11" onClick={() => setToken("")}>Hide token</button></div>}
      <ul className="space-y-3">{data?.stdioGrants.map(grant => <li className="rounded-xl border border-base-300 p-3 space-y-2 min-w-0" key={grant.id}><strong>{grant.clientName}</strong><p className="text-sm">{grant.scopes.join(", ")}</p><p className="text-sm">Expires {expiry(grant.expiresAt)} · {grant.revokedAt ? "Revoked" : Date.parse(String(grant.expiresAt)) <= readAt ? "Expired" : "Not revoked; session-bound"}</p>{!grant.revokedAt && <button className="btn btn-outline min-h-11 w-full sm:w-auto" disabled={busy} onClick={() => void revoke(grant.id, "stdio")}>Revoke private client</button>}</li>)}</ul>
    </section>{data && <p className="text-xs opacity-70">{data.limitation} Last read: {expiry(data.asOf)}.</p>}
  </div>;
}
