"use client";

import Link from "next/link";
import { useState } from "react";
import type { getWarehouseUnit, getWarehouseUnitObservations, getWarehouseSourceRevisions, WarehouseIdentifierKind } from "@/lib/warehouse/units";

type UnitDetail = Awaited<ReturnType<typeof getWarehouseUnit>>;
function when(value: string | null) { return value ? new Date(value).toLocaleString() : "Not recorded"; }

export default function WarehouseUnitClient({ initial, canIdentify }: { initial: UnitDetail; canIdentify: boolean }) {
  const [unit, setUnit] = useState(initial);
  const [observationCursor, setObservationCursor] = useState(initial.observationHistoryCursor);
  const [sourceCursor, setSourceCursor] = useState<string | null>(null);
  const [sourceHasMore, setSourceHasMore] = useState(initial.sourceHistoryMayBeTruncated);
  const [kind, setKind] = useState<WarehouseIdentifierKind>("msn");
  const [value, setValue] = useState("");
  const [namespace, setNamespace] = useState("");
  const [evidence, setEvidence] = useState("");
  const [revokeId, setRevokeId] = useState("");
  const [revokeReason, setRevokeReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function refresh() {
    const response = await fetch(`/api/warehouse/units?${new URLSearchParams({ unitId: unit.unitId })}`, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error || "Unit history could not reload.");
    setUnit(body.result); setObservationCursor(body.result.observationHistoryCursor); setSourceCursor(null); setSourceHasMore(body.result.sourceHistoryMayBeTruncated);
  }
  async function mutate(method: "POST" | "DELETE", body: unknown) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/warehouse/identifiers", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Identifier action failed.");
      setNotice(method === "DELETE" ? "Link revoked. Its original evidence remains in history." : payload.result.resolution === "ambiguous" ? "Link recorded. This identifier now matches multiple units and requires review; no units were merged." : "Identifier link recorded.");
      setValue(""); setEvidence(""); setRevokeId(""); setRevokeReason("");
      await refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Identifier action failed."); }
    finally { setBusy(false); }
  }
  async function loadHistory(kind: "observations" | "source") {
    setBusy(true); setError("");
    try {
      const cursor = kind === "observations" ? observationCursor : sourceCursor;
      const params = new URLSearchParams({ unitId: unit.unitId, history: kind, ...(cursor ? { cursor } : {}) });
      const response = await fetch(`/api/warehouse/units?${params}`, { cache: "no-store" }); const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error || "History could not load.");
      if (kind === "observations") {
        const page = body.result as Awaited<ReturnType<typeof getWarehouseUnitObservations>>;
        setUnit((previous) => ({ ...previous, observations: [...new Map([...previous.observations, ...page.items].map((item) => [item.observationId, item])).values()], observationsMayBeTruncated: page.hasMore }));
        setObservationCursor(page.nextCursor);
      } else {
        const page = body.result as Awaited<ReturnType<typeof getWarehouseSourceRevisions>>;
        setUnit((previous) => ({ ...previous, reportedRows: previous.reportedRows.map((row) => ({ ...row, sourceHistory: [...new Map([...row.sourceHistory, ...page.items.filter((item) => item.inventoryRecordId === row.inventoryRecordId)].map((item) => [item.sourceRevisionId, item])).values()].sort((a, b) => b.revision - a.revision) })) }));
        setSourceCursor(page.nextCursor); setSourceHasMore(page.hasMore);
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "History could not load."); }
    finally { setBusy(false); }
  }
  return <div className="space-y-5"><header><h1 className="text-2xl font-bold">Physical-unit history</h1><p className="mt-1 break-all text-xs text-base-content/65">{unit.unitId}</p><p className="mt-2 text-sm">Order numbers are context. Aliases link this appliance across systems; source reports and observations remain separate.</p></header>
    {error && <p role="alert" className="alert alert-error text-sm">{error}</p>}{notice && <p role="status" className="rounded-xl border border-info/40 bg-info/10 p-3 text-sm">{notice}</p>}
    <section className="rounded-xl border border-info/40 bg-info/10 p-4 space-y-1"><h2 className="font-semibold">Last physical observation</h2><p className="text-lg font-bold">{unit.physicalState.basis === "conflicting_physical_observations" ? "Conflicting observations — review locations" : unit.physicalState.lastType?.replaceAll("_", " ") || "No physical observation recorded"}</p><p>{unit.physicalState.location || "Location not recorded"} · {when(unit.physicalState.observedAt)}</p><p className="text-xs">Received {when(unit.physicalState.receivedAt)}. This describes evidence at that time; it does not guarantee current presence.</p></section>
    <section className="space-y-3"><h2 className="text-lg font-semibold">Identifier links</h2>{unit.identifiers.map((alias) => <article key={alias.identifierId} className={`rounded-xl border border-base-300 bg-base-100 p-4 space-y-1 ${alias.revokedAt ? "opacity-70" : ""}`}><p className="text-xs uppercase">{alias.kind} · {alias.namespace} · {alias.revokedAt ? "revoked" : "active"}</p><p className="break-all text-lg font-bold">{alias.value}</p><p className="break-words text-sm">Evidence: {alias.evidence}</p><p className="text-xs text-base-content/70">Linked {when(alias.linkedAt)}</p>{alias.revokedAt && <p className="break-words text-xs">Revoked {when(alias.revokedAt)}: {alias.revocationReason}</p>}{canIdentify && !alias.revokedAt && <button className="btn btn-sm btn-outline mt-2" onClick={() => { setRevokeId(alias.identifierId); setRevokeReason(""); }}>Correct / revoke link</button>}</article>)}{!unit.identifiers.length && <p className="text-sm">No identifier links yet.</p>}</section>
    {canIdentify && <details className="rounded-xl border border-base-300 bg-base-100 p-4"><summary className="cursor-pointer font-semibold">Link an evidenced identifier</summary><form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); void mutate("POST", { unitId: unit.unitId, kind, value, namespace: namespace || undefined, evidence }); }}><label className="form-control"><span className="label-text">Identifier type</span><select className="select select-bordered mt-1 w-full" value={kind} onChange={(event) => setKind(event.target.value as WarehouseIdentifierKind)}><option value="lpn">LPN</option><option value="msn">MSN</option><option value="serial">Serial</option><option value="submission">MARS submission</option></select></label><label className="form-control"><span className="label-text">Identifier</span><input className="input input-bordered mt-1 w-full" value={value} maxLength={500} onChange={(event) => setValue(event.target.value)} required /></label><label className="form-control"><span className="label-text">Namespace{kind === "serial" ? " (manufacturer/model required)" : " (optional)"}</span><input className="input input-bordered mt-1 w-full" value={namespace} maxLength={100} onChange={(event) => setNamespace(event.target.value)} required={kind === "serial"} /></label><label className="form-control"><span className="label-text">Evidence connecting this identifier to this physical appliance</span><textarea className="textarea textarea-bordered mt-1 w-full" value={evidence} maxLength={2000} onChange={(event) => setEvidence(event.target.value)} required /></label><p className="text-xs text-base-content/70">Do not link by order number alone. A conflicting identifier is kept ambiguous; this action never merges units.</p><button className="btn btn-primary w-full" disabled={busy || !value.trim() || !evidence.trim()}>Record identifier link</button></form></details>}
    {canIdentify && revokeId && <form className="rounded-xl border border-warning bg-warning/10 p-4 space-y-3" onSubmit={(event) => { event.preventDefault(); void mutate("DELETE", { identifierId: revokeId, reason: revokeReason }); }}><h2 className="font-semibold">Correct identifier linkage</h2><p className="text-sm">Revoking prevents future matching through this link. Prior observations and link evidence stay intact; correct an observation separately if its unit association was wrong.</p><label className="form-control"><span className="label-text">Reason</span><textarea className="textarea textarea-bordered mt-1 w-full" value={revokeReason} maxLength={2000} onChange={(event) => setRevokeReason(event.target.value)} required /></label><div className="flex flex-wrap gap-2"><button className="btn btn-warning" disabled={busy || !revokeReason.trim()}>Revoke link</button><button type="button" className="btn btn-ghost" onClick={() => setRevokeId("")}>Cancel</button></div></form>}
    <section className="space-y-3"><h2 className="text-lg font-semibold">WMS reported history</h2>{unit.reportedRows.map((row) => <article key={row.inventoryRecordId} className="rounded-xl border border-base-300 bg-base-100 p-4 space-y-2"><h3 className="break-all text-lg font-bold">{row.lpn}</h3><p className="break-words">{row.description}</p><p className="text-sm">WMS: {row.reportedStatus} · Order context: {row.orderNumber || "not recorded"}{row.archivedAt ? " · archived source row" : ""}</p><details><summary className="cursor-pointer font-semibold">Recent source revisions ({row.sourceHistory.length} shown; older history retained)</summary><div className="mt-3 space-y-3">{row.sourceHistory.map((revision) => <div key={revision.sourceRevisionId} className="rounded-lg border border-base-300 p-3"><p className="font-semibold">Revision {revision.revision}{revision.migrationSnapshot ? " · migration snapshot; earlier rows not recoverable" : ""}</p><p className="text-xs">Retained {when(revision.recordedAt)}</p>{revision.reports.map((report) => <p className="mt-1 text-xs" key={report.importId}>{report.scope} · {report.coverage} · imported {when(report.importedAt)} · source-as-of {when(report.sourceAsOf)}</p>)}<pre className="mt-2 whitespace-pre-wrap break-all text-xs">{JSON.stringify(revision.sourceData, null, 2)}</pre></div>)}</div></details></article>)}{!unit.reportedRows.length && <p className="text-sm">No linked WMS source row. This unit may have been identified independently.</p>}{sourceHasMore && <button className="btn btn-outline w-full" disabled={busy} onClick={() => void loadHistory("source")}>Load more retained source history</button>}</section>
    <section className="space-y-3"><h2 className="text-lg font-semibold">Physical observation trail</h2>{unit.observations.map((observation) => <article className="rounded-xl border border-base-300 bg-base-100 p-4 space-y-1" key={observation.observationId}><p className="font-semibold">{observation.type.replaceAll("_", " ")} · {when(observation.capturedAt)}</p>{!observation.associationCurrent && <p className="text-xs font-semibold text-warning">Historical association only; corrected away from this unit. It does not affect the physical summary.</p>}<p className="break-words text-sm">{observation.location || "Location not recorded"} · {observation.captureMethod}</p><p className="break-all text-sm">Scanned {observation.rawIdentifier}</p><p className="text-xs text-base-content/70">Operator {observation.capturedByUserId} · received {when(observation.receivedAt)}</p>{observation.corrections.map((correction) => <p key={correction.correctionId} className="break-words text-xs text-warning">Identity correction {correction.revision}: {correction.reason} · {when(correction.correctedAt)}</p>)}</article>)}{!unit.observations.length && <p className="text-sm">No physical observations establish where this unit has been.</p>}{observationCursor && <button className="btn btn-outline w-full" disabled={busy} onClick={() => void loadHistory("observations")}>Load older physical observations</button>}</section>
    <div className="flex flex-wrap gap-2"><button className="btn btn-outline" disabled={busy} onClick={() => void refresh().catch((failure) => setError(failure instanceof Error ? failure.message : "History unavailable."))}>Refresh history</button><a className="btn btn-outline" href={`/api/warehouse/units?${new URLSearchParams({ unitId: unit.unitId, format: "json" })}`}>Export full history JSON</a><Link href="/tools/warehouse/units" className="btn btn-outline">Find another identifier</Link><Link href="/tools/warehouse-scan" className="btn btn-primary">Record warehouse observation</Link></div>
  </div>;
}
