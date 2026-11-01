"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import ScannerCapture, { type ScannerFeedback } from "@/components/scanner/ScannerCapture";
import type { listUnresolvedWarehouseObservations, resolveWarehouseIdentifier } from "@/lib/warehouse/units";

type Resolution = Awaited<ReturnType<typeof resolveWarehouseIdentifier>>;
type Unresolved = Awaited<ReturnType<typeof listUnresolvedWarehouseObservations>>;

export default function WarehouseIdentityClient({ canIdentify }: { canIdentify: boolean }) {
  const [value, setValue] = useState("");
  const [result, setResult] = useState<Resolution | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [feedback, setFeedback] = useState<ScannerFeedback | null>(null);
  const [unresolved, setUnresolved] = useState<Unresolved | null>(null);
  const [correcting, setCorrecting] = useState<Unresolved[number] | null>(null);
  const [reason, setReason] = useState("");
  const [creationEvidence, setCreationEvidence] = useState("");
  const [createdUnitId, setCreatedUnitId] = useState("");
  const [busy, setBusy] = useState(false);
  const operation = useRef<string | null>(null);
  const correctionOperation = useRef<string | null>(null);

  async function resolve(raw: string) {
    if (!raw.trim()) return;
    setBusy(true); setError(""); setResult(null);
    try {
      const response = await fetch(`/api/warehouse/units?${new URLSearchParams({ value: raw, kind: "auto" })}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Identifier lookup failed.");
      const resolved = payload.result as Resolution;
      setResult(resolved); setValue(raw);
      setFeedback({ tone: resolved.resolution === "resolved" ? "success" : "warning", title: resolved.resolution === "resolved" ? "Linked physical unit found" : resolved.resolution === "ambiguous" ? "Ambiguous identifier — inspect another barcode" : "Identifier not linked", detail: "Lookup records no physical completion.", value: raw });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Identifier lookup failed."); }
    finally { setBusy(false); }
  }
  async function loadUnresolved() {
    setError("");
    try {
      const response = await fetch("/api/warehouse/observations", { cache: "no-store" }); const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not load observations.");
      setUnresolved(payload.observations);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not load observations."); }
  }
  async function correct(unitId: string) {
    if (!correcting) return;
    setBusy(true); setError("");
    try {
      correctionOperation.current ??= crypto.randomUUID();
      const response = await fetch("/api/warehouse/observations/corrections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ observationId: correcting.observationId, operationId: correctionOperation.current, expectedRevision: correcting.correctionRevision, unitId, reason }) });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Correction failed.");
      setCorrecting(null); setReason(""); correctionOperation.current = null; setNotice("Observation association amended. The original captured evidence is retained."); await loadUnresolved();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Correction failed."); }
    finally { setBusy(false); }
  }
  async function createUnit() {
    setBusy(true); setError("");
    try {
      operation.current ??= crypto.randomUUID();
      const response = await fetch("/api/warehouse/units", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operationId: operation.current, evidence: creationEvidence }) });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not create unit identity.");
      setCreatedUnitId(payload.result.unitId); operation.current = null; setCreationEvidence("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not create unit identity."); }
    finally { setBusy(false); }
  }
  return <div className="space-y-5"><header><h1 className="text-2xl font-bold">Find a linked physical unit</h1><p className="mt-2 text-sm">Scan LPN, MSN, serial or MARS submission. Order numbers remain context; this lookup never merges original and replacement appliances.</p></header>
    <form className="rounded-xl border border-base-300 bg-base-100 p-4 space-y-3" onSubmit={(event) => { event.preventDefault(); void resolve(value); }}><label className="form-control"><span className="label-text font-semibold">Linked identifier</span><input className="input input-bordered mt-1 w-full" value={value} onChange={(event) => setValue(event.target.value)} maxLength={500} autoCapitalize="off" autoComplete="off" required /></label><button className="btn btn-primary min-h-12 w-full" disabled={busy || !value.trim()}>Find unit</button></form>
    <ScannerCapture title="Unit Identifier Lookup" description="Scan a linked LPN, MSN, serial or submission. This is a lookup, not a presence confirmation." onScan={(raw) => resolve(raw)} feedback={feedback} />
    {error && <p role="alert" className="alert alert-error text-sm">{error}</p>}{notice && <p role="status" className="rounded-xl border border-info/40 bg-info/10 p-3 text-sm">{notice}</p>}
    {correcting && <section className="rounded-xl border border-warning bg-warning/10 p-4 space-y-3"><h2 className="font-semibold">Amend captured observation identity</h2><p className="break-all text-sm">Original scan: {correcting.rawIdentifier} · {new Date(correcting.capturedAt).toLocaleString()}</p><p className="text-sm">Look up another evidenced identifier above, review the correct appliance, then associate this observation. Its original raw scan, operator and timestamp remain.</p><label className="form-control"><span className="label-text">Evidence / reason</span><textarea className="textarea textarea-bordered mt-1 w-full" value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} /></label><button className="btn btn-sm btn-ghost" onClick={() => setCorrecting(null)}>Cancel amendment</button></section>}
    {result && <section className="space-y-3"><h2 className="text-lg font-semibold">{result.resolution === "resolved" ? "One linked unit" : result.resolution === "ambiguous" ? "Ambiguous — multiple unit candidates" : "No linked unit"}</h2>{result.candidates.map((candidate) => <article className="rounded-xl border border-base-300 bg-base-100 p-4 space-y-2" key={candidate.unitId}><p className="break-all font-bold">{candidate.lpns.join(" · ") || "Independently identified unit"}</p>{candidate.reportedRows.map((row) => <p className="break-words text-sm" key={row.lpn}>{row.description} · WMS {row.status} · order context {row.orderNumber || "not recorded"}</p>)}<Link className="btn btn-outline w-full" href={`/tools/warehouse/unit/${encodeURIComponent(candidate.unitId)}`}>Inspect unit history</Link>{correcting && canIdentify && <button className="btn btn-warning w-full" disabled={busy || !reason.trim()} onClick={() => void correct(candidate.unitId)}>Associate original observation with this unit</button>}</article>)}{result.resolution !== "resolved" && <p className="text-sm">Use another identifier or authorized identity review. No physical unit was selected automatically.</p>}</section>}
    <section className="space-y-3"><button className="btn btn-outline w-full" onClick={() => void loadUnresolved()}>Review recent unresolved / ambiguous scans</button>{unresolved?.map((observation) => <article key={observation.observationId} className="rounded-xl border border-base-300 bg-base-100 p-4 space-y-2"><p className="break-all font-bold">{observation.rawIdentifier}</p><p className="text-sm">{observation.resolution} · {observation.type.replaceAll("_", " ")} · {new Date(observation.capturedAt).toLocaleString()}</p><p className="text-sm">{observation.location || "Location not recorded"}</p>{canIdentify && <button className="btn btn-sm btn-outline" onClick={() => { setCorrecting(observation); setReason(""); correctionOperation.current = null; }}>Resolve identity with evidence</button>}</article>)}{unresolved?.length === 0 && <p className="text-sm">No recent unresolved observations need review.</p>}</section>
    {canIdentify && <details className="rounded-xl border border-base-300 bg-base-100 p-4"><summary className="cursor-pointer font-semibold">Create an independently identified physical unit</summary><p className="mt-3 text-sm">Use only when an actual distinct appliance has no existing unit record. Search existing identifiers first. This creates identity, not presence; link evidenced identifiers on the new unit page.</p><form className="mt-3 space-y-3" onSubmit={(event) => { event.preventDefault(); void createUnit(); }}><label className="form-control"><span className="label-text">Evidence that this is a separate physical appliance</span><textarea className="textarea textarea-bordered mt-1 w-full" value={creationEvidence} onChange={(event) => setCreationEvidence(event.target.value)} maxLength={2000} required /></label><button className="btn btn-primary w-full" disabled={busy || !creationEvidence.trim()}>Create separate unit identity</button></form>{createdUnitId && <Link className="btn btn-outline mt-3 w-full" href={`/tools/warehouse/unit/${encodeURIComponent(createdUnitId)}`}>Open created unit and link identifiers</Link>}</details>}
  </div>;
}
