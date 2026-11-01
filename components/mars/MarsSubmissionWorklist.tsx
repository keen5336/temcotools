"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import ScannerCapture from "@/components/scanner/ScannerCapture";

type Intent = { id: string; unitId: string; state: string; revision: number; authorizationId: string | null; authorizationExpiresAt: string; requestNumber: string | null; evidence: string; events: Array<{ id: string; action: string; evidence: string; createdAt: string }> };
type Disposition = { id: string; kind: string; status: string; instruction: string; expiresAt: string | null };
async function action(name: string, input: unknown) {
  const response = await fetch(`/api/application/${encodeURIComponent(name)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const payload = await response.json(); if (!response.ok) throw Object.assign(new Error(payload.error || "MARS work could not be saved. Retain its operation ID before retrying."), { status: response.status }); return payload.result;
}
export default function MarsSubmissionWorklist({ currentUserId, canExecute, canAuthorize }: { currentUserId: string; canExecute: boolean; canAuthorize: boolean }) {
  const [unitId, setUnitId] = useState("");
  const [intents, setIntents] = useState<Intent[]>([]);
  const [dispositions, setDispositions] = useState<Disposition[]>([]);
  const [authorizationId, setAuthorizationId] = useState("");
  const [evidence, setEvidence] = useState("");
  const [requestNumber, setRequestNumber] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ name: string; input: Record<string, unknown> } | null>(null);
  const refresh = useCallback(async () => {
    const list = await action("mars.intents", { ...(unitId ? { unitId } : {}), includeResolved: true, limit: 100 }); setIntents(list.intents);
    if (unitId) { const context = await action("office.unit", { unitId }); setDispositions(context.dispositions); }
    else setDispositions([]);
  }, [unitId]);
  useEffect(() => { const timer = window.setTimeout(() => { void refresh().catch(error => setMessage(error.message)); }, 0); return () => window.clearTimeout(timer); }, [refresh]);
  async function run(name: string, input: Record<string, unknown>) {
    setBusy(true); setMessage("");
    const work = { name, input: { ...input, operationId: input.operationId ?? crypto.randomUUID() } };
    setPending(work);
    try { const receipt = await action(work.name, work.input); setPending(null); setMessage(receipt.next || "Local evidence saved. No upstream submission or print was performed by the app."); await refresh(); }
    catch (error) { if (error && typeof error === "object" && "status" in error && Number(error.status) >= 400 && Number(error.status) < 500) { setPending(null); await refresh().catch(() => undefined); } setMessage(error instanceof Error ? error.message : "The result is uncertain. Retry the same local operation to recover its receipt."); }
    finally { setBusy(false); }
  }
  async function identify(value: string, source: "scanner" | "manual") {
    setMessage("");
    if (!canExecute) {
      const response = await fetch(`/api/warehouse/units?value=${encodeURIComponent(value)}`, { cache: "no-store" }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error); if (payload.result.resolution !== "resolved") throw new Error("Identifier is unknown or ambiguous. Use the warehouse identity review."); setUnitId(payload.result.unitId); return;
    }
    const response = await fetch("/api/scan-ingestion", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ eventId: crypto.randomUUID(), capturedByUserId: currentUserId, rawIdentifier: value, identifierType: "auto", type: "presence", capturedAt: new Date().toISOString(), captureMethod: source }) });
    const payload = await response.json(); if (!response.ok) throw new Error(payload.error); const receipt = payload.result ?? payload;
    if (receipt.resolution !== "resolved" || !receipt.unitId) throw new Error("Sighting evidence retained; physical identity is unknown or ambiguous. Review it before MARS work.");
    setUnitId(receipt.unitId); setAuthorizationId(""); setMessage("Presence observation saved. This does not confirm a return check-in, lane placement or departure.");
  }
  const input = (intent: Intent) => ({ intentId: intent.id, expectedRevision: intent.revision, evidence });
  const authorized = dispositions.filter(item => ["rtv","conditional_rtv"].includes(item.kind) && ["active","triggered","executed"].includes(item.status));
  return <div className="space-y-4">
    <Link className="btn btn-outline w-full" href="/tools/office">Expected returns, office decisions and trail gaps</Link>
    <ScannerCapture title="Identify the physical return" description={canExecute ? "A fresh scan records presence globally, then loads the exact unit. It does not create a MARS submission." : "Look up any evidenced linked identifier."} onScan={identify} enabled={!busy && !pending} />
    {message && <p className="alert block break-words" role="status">{message}</p>}
    {pending && <div className="alert alert-warning block space-y-2"><p>This local command is preserved in this page. Retry it unchanged to recover the same receipt; do not start the external workflow again.</p><button className="btn w-full" disabled={busy} onClick={() => void run(pending.name, pending.input)}>Retry the same local command</button></div>}
    {unitId && <section className="card bg-base-100 border border-base-300"><div className="card-body space-y-3"><h2 className="font-bold break-all">Exact unit {unitId}</h2><Link className="link" href={`/tools/warehouse/unit/${encodeURIComponent(unitId)}`}>Unit identity, observations and notes</Link><label>Office authority<select className="select select-bordered w-full" value={authorizationId} onChange={event => setAuthorizationId(event.target.value)}><option value="">{canAuthorize ? "Authorize this exact unit with my current permission (1 hour)" : "Select this unit's current RTV authorization"}</option>{authorized.map(item => <option value={item.id} key={item.id}>{item.kind} · {item.status} · {item.instruction}</option>)}</select></label>{!canAuthorize && !authorized.length && <p>Office must authorize this exact unit before MARS work. An original unit&#39;s instruction cannot authorize its replacement.</p>}<label>Evidence / verification reason<textarea className="textarea textarea-bordered w-full" value={evidence} onChange={event => setEvidence(event.target.value)} maxLength={2000} placeholder="What was observed or verified, and why this unit needs this action" /></label><button className="btn btn-primary w-full" disabled={!canExecute || busy || Boolean(pending) || evidence.trim().length < 5 || (!canAuthorize && !authorizationId)} onClick={() => void run("mars.intent.prepare", { unitId, evidence, ...(authorizationId ? { authorizationId } : {}) })}>Prepare authorized human MARS work</button></div></section>}
    <label className="block">Observed submission number<input className="input input-bordered w-full" value={requestNumber} onChange={event => setRequestNumber(event.target.value)} maxLength={200} inputMode="numeric" placeholder="Record only the actual result from the supported MARS workflow" /></label>
    {intents.map(intent => <article className="card bg-base-100 border border-base-300" key={intent.id}><div className="card-body space-y-3"><h2 className="font-bold">{intent.state.replaceAll("_"," ")}</h2><p className="text-sm break-all">Unit {intent.unitId} · Revision {intent.revision}</p><p>{intent.evidence}</p><p className="text-sm">Authority expires {new Date(intent.authorizationExpiresAt).toLocaleString()}. Submission is separate from pickup/physical departure.</p>{!unitId && <button className="btn btn-outline" onClick={() => setUnitId(intent.unitId)}>Select this exact unit</button>}{canExecute && <div className="grid gap-2"><button className="btn btn-primary" disabled={busy || Boolean(pending) || evidence.trim().length < 5 || intent.state !== "prepared"} onClick={() => void run("mars.intent.start", input(intent))}>Record human workflow handoff</button><button className="btn btn-warning" disabled={busy || Boolean(pending) || evidence.trim().length < 5 || !["prepared","in_progress"].includes(intent.state)} onClick={() => void run("mars.intent.unknown", input(intent))}>Record uncertain result — block replay</button><button className="btn btn-outline" disabled={busy || Boolean(pending) || evidence.trim().length < 5 || !requestNumber.trim() || !["prepared","in_progress","unknown"].includes(intent.state)} onClick={() => void run("mars.intent.reconcile", { ...input(intent), outcome: "linked", requestNumber })}>Link the verified resulting submission</button>{canAuthorize && <button className="btn btn-outline" disabled={busy || Boolean(pending) || evidence.trim().length < 5 || !["in_progress","unknown"].includes(intent.state)} onClick={() => void run("mars.intent.reconcile", { ...input(intent), outcome: "verified_not_submitted" })}>Record verified absence of submission</button>}<button className="btn btn-outline" disabled={busy || Boolean(pending) || evidence.trim().length < 5 || intent.state !== "prepared"} onClick={() => void run("mars.intent.cancel", input(intent))}>Cancel unstarted preparation</button></div>}{intent.requestNumber && <button className="btn btn-outline" disabled={busy} onClick={() => { void action("mars.label.handoff", { unitId: intent.unitId, requestNumber: intent.requestNumber }).then(result => { window.location.href = result.labelUrl; }).catch(error => setMessage(error.message)); }}>Review existing submission label</button>}<details><summary className="cursor-pointer">Retained intent history</summary>{intent.events.map(event => <p className="text-sm border-t border-base-300 py-2" key={event.id}>{event.action} · {new Date(event.createdAt).toLocaleString()}<br />{event.evidence}</p>)}</details></div></article>)}
    <p className="text-sm">No automated MARS creation adapter is qualified. Use the supported signed-in external workflow manually after the handoff, then record its result. Unknown results stay blocked for reconciliation.</p>
  </div>;
}
