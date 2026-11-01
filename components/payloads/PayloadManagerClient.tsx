"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { DEFAULT_DMP_PAYLOAD_ID, PAYLOAD_PURPOSES, MAX_PAYLOAD_BYTES, sourceChanges } from "@/lib/payloads/types";
import { MARS_LABEL_PAYLOAD_ID } from "@/lib/mars-label-bookmarklet";

type PayloadRow = { id: string; name: string; purpose: string; targetOrigins: string[]; enabled: boolean; revision: number; publishedVersionId: string | null; loaderUrl: string; bookmarklet: string };
type Version = { id: string; version: number; contentHash: string; publishedAt: string; publishedByUserId: string; note: string; source?: string };
type Audit = { id: string; actorUserId: string; action: string; revision: number; versionId: string | null; note: string; createdAt: string };
type Detail = PayloadRow & { draftSource: string; protocolVersion: number; operationNames: string[]; publishedVersion: Version | null; versions: Version[]; audits: Audit[] };
type Draft = { id: string; name: string; purpose: string; targetOrigins: string; source: string; protocolVersion: number; operationNames: string };
const emptyDraft: Draft = { id: "", name: "", purpose: "dmp_relay", targetOrigins: "https://dmp.extapps.homedepot.com", source: "// Load the current DMP executor or enter the approved helper source.\n", protocolVersion: 1, operationNames: "session\ndeliveries" };
async function jsonRequest(url: string, body?: unknown) {
  const response = await fetch(url, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Payload action failed. Reload before repeating it.");
  return data;
}
function downloadSource(name: string, source: string) {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript;charset=utf-8" }));
  const element = document.createElement("a"); element.href = url; element.download = `${name || "payload"}-draft.js`; element.click(); URL.revokeObjectURL(url);
}
function safeTarget(value: string) { try { const url = new URL(value); return url.protocol === "https:" && url.origin === value && !url.hostname.includes("*") ? url.href : null; } catch { return null; } }

export default function PayloadManagerClient() {
  const [payloads, setPayloads] = useState<PayloadRow[]>([]), [detail, setDetail] = useState<Detail | null>(null), [draft, setDraft] = useState<Draft>(emptyDraft);
  const [builtin, setBuiltin] = useState<{ source: string; targetOrigins: string[] } | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [note, setNote] = useState("");
  const [builtinMars, setBuiltinMars] = useState<{ source: string; targetOrigins: string[] } | null>(null);
  const [builtinRoutePlanner, setBuiltinRoutePlanner] = useState<{ source: string; targetOrigins: string[] } | null>(null);
  const [reviewed, setReviewed] = useState(false), [preview, setPreview] = useState(""), [search, setSearch] = useState(""), [undo, setUndo] = useState<string[]>([]);
  const [comparison, setComparison] = useState(""), [comparisonLabel, setComparisonLabel] = useState("No published version"), [versionId, setVersionId] = useState("");
  const [moreVersions, setMoreVersions] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const guard = useRef({ alive: false, listSequence: 0, selectionSequence: 0, editorScope: 0, previewSequence: 0, importSequence: 0 });
  const load = useCallback(async () => {
    const sequence = ++guard.current.listSequence;
    try { const data = await jsonRequest("/api/payloads"); if (!guard.current.alive || sequence !== guard.current.listSequence) return; setPayloads(data.payloads); setBuiltin(data.builtinDmp); setBuiltinMars(data.builtinMarsLabel); setBuiltinRoutePlanner(data.builtinRoutePlanner); }
    catch (error) { if (guard.current.alive && sequence === guard.current.listSequence) throw error; }
  }, []);
  useEffect(() => {
    const lifecycle = guard.current; lifecycle.alive = true;
    const timer = window.setTimeout(() => { void load().catch(error => { if (lifecycle.alive) setMessage(error.message); }); }, 0);
    return () => { window.clearTimeout(timer); lifecycle.alive = false; lifecycle.listSequence++; lifecycle.selectionSequence++; lifecycle.editorScope++; lifecycle.previewSequence++; lifecycle.importSequence++; };
  }, [load]);
  const changes = useMemo(() => sourceChanges(comparison, draft.source), [comparison, draft.source]);
  const selected = payloads.find(payload => payload.id === detail?.id);
  const targetHref = safeTarget(draft.targetOrigins.split(/\r?\n/)[0]?.trim() ?? "");
  const unsaved = Boolean(detail && (draft.name !== detail.name || draft.purpose !== detail.purpose || draft.targetOrigins !== detail.targetOrigins.join("\n") || draft.source !== detail.draftSource || draft.operationNames !== detail.operationNames.join("\n")));
  function invalidatePreview() { guard.current.previewSequence++; setPreview(""); setReviewed(false); }
  function editSource(source: string) { setUndo(values => [...values.slice(-29), draft.source]); setDraft(value => ({ ...value, source })); invalidatePreview(); }
  function setField<K extends keyof Draft>(field: K, value: Draft[K]) { setDraft(current => ({ ...current, [field]: value })); invalidatePreview(); }
  function beginNew() { guard.current.selectionSequence++; guard.current.editorScope++; guard.current.importSequence++; invalidatePreview(); setDetail(null); setDraft(emptyDraft); setUndo([]); setComparison(""); setComparisonLabel("No published version"); setVersionId(""); setMoreVersions(false); setNote(""); setSearch(""); }
  async function select(payloadId: string) {
    const sequence = ++guard.current.selectionSequence; guard.current.editorScope++; guard.current.importSequence++; invalidatePreview();
    setBusy(true); setMessage("");
    try {
      const value: Detail = await jsonRequest(`/api/payloads/${encodeURIComponent(payloadId)}`);
      if (!guard.current.alive || sequence !== guard.current.selectionSequence) return false;
      setDetail(value); setDraft({ id: value.id, name: value.name, purpose: value.purpose, targetOrigins: value.targetOrigins.join("\n"), source: value.draftSource, protocolVersion: value.protocolVersion, operationNames: value.operationNames.join("\n") });
      setComparison(value.publishedVersion?.source ?? ""); setComparisonLabel(value.publishedVersion ? `Published v${value.publishedVersion.version}` : "No published version"); setVersionId(""); setUndo([]); setPreview(""); setReviewed(false); setMoreVersions(value.versions.length === 50);
      return true;
    } catch (error) { if (guard.current.alive && sequence === guard.current.selectionSequence) setMessage(error instanceof Error ? error.message : "Could not load payload."); return false; } finally { if (guard.current.alive && sequence === guard.current.selectionSequence) setBusy(false); }
  }
  function serializedDraft() { return { ...draft, targetOrigins: draft.targetOrigins.split(/\r?\n/).map(value => value.trim()).filter(Boolean), operationNames: draft.operationNames.split(/\r?\n/).map(value => value.trim()).filter(Boolean), note }; }
  async function save() {
    const scope = guard.current.editorScope;
    setBusy(true); setMessage("");
    try { const value = await jsonRequest(detail ? `/api/payloads/${encodeURIComponent(detail.id)}` : "/api/payloads", { ...serializedDraft(), ...(detail ? { action: "save", expectedRevision: detail.revision } : {}) }); await load(); if (!guard.current.alive || scope !== guard.current.editorScope) return; if (await select(value.id)) setMessage("Draft saved. Installed loaders still use the published version."); }
    catch (error) { if (guard.current.alive && scope === guard.current.editorScope) setMessage(error instanceof Error ? error.message : "Draft save failed."); } finally { if (guard.current.alive) setBusy(false); }
  }
  async function action(kind: "publish" | "rollback" | "enabled") {
    if (!detail) return;
    const scope = guard.current.editorScope;
    setBusy(true); setMessage("");
    try { await jsonRequest(`/api/payloads/${encodeURIComponent(detail.id)}`, { action: kind, expectedRevision: detail.revision, note, reviewedNoSecrets: reviewed, versionId, enabled: !detail.enabled }); await load(); if (!guard.current.alive || scope !== guard.current.editorScope) return; if (await select(detail.id)) setMessage(kind === "publish" ? "Published for the next loader invocation. Existing requests were not replaced or replayed." : kind === "rollback" ? "Published pointer rolled back. Existing requests remain pinned." : "Payload availability updated. Already loaded code may remain in a browser; server authorization still applies."); }
    catch (error) { if (guard.current.alive && scope === guard.current.editorScope) setMessage(error instanceof Error ? error.message : "Payload action failed."); } finally { if (guard.current.alive) setBusy(false); }
  }
  async function viewVersion(id: string) {
    if (!detail) return;
    const scope = guard.current.editorScope;
    setBusy(true);
    try { const version: Version = await jsonRequest(`/api/payloads/${encodeURIComponent(detail.id)}/versions/${encodeURIComponent(id)}`); if (!guard.current.alive || scope !== guard.current.editorScope) return; setComparison(version.source ?? ""); setComparisonLabel(`Published v${version.version}`); setVersionId(id); }
    catch (error) { if (guard.current.alive && scope === guard.current.editorScope) setMessage(error instanceof Error ? error.message : "Could not load version."); } finally { if (guard.current.alive && scope === guard.current.editorScope) setBusy(false); }
  }
  async function loadMoreVersions() {
    if (!detail?.versions.length) return;
    const scope = guard.current.editorScope, payloadId = detail.id;
    setBusy(true);
    try {
      const result = await jsonRequest(`/api/payloads/${encodeURIComponent(detail.id)}/versions?before=${detail.versions.at(-1)!.version}`);
      if (!guard.current.alive || scope !== guard.current.editorScope) return;
      setDetail(value => value?.id === payloadId ? { ...value, versions: [...value.versions, ...result.versions.filter((version: Version) => !value.versions.some(existing => existing.id === version.id))] } : value); setMoreVersions(result.nextBeforeVersion !== null);
    } catch (error) { if (guard.current.alive && scope === guard.current.editorScope) setMessage(error instanceof Error ? error.message : "Could not load older versions."); } finally { if (guard.current.alive && scope === guard.current.editorScope) setBusy(false); }
  }
  async function previewDraft() {
    const scope = guard.current.editorScope, sequence = ++guard.current.previewSequence;
    setBusy(true); setMessage("");
    try { const result = await jsonRequest("/api/payloads", { ...serializedDraft(), action: "preview" }); if (!guard.current.alive || scope !== guard.current.editorScope || sequence !== guard.current.previewSequence) return; setPreview(result.previewHtml); setMessage(result.limitations); }
    catch (error) { if (guard.current.alive && scope === guard.current.editorScope && sequence === guard.current.previewSequence) setMessage(error instanceof Error ? error.message : "Preview validation failed."); } finally { if (guard.current.alive && scope === guard.current.editorScope) setBusy(false); }
  }
  async function copy(value: string) { try { await navigator.clipboard.writeText(value); setMessage("Copied. Keep any private source outside public repositories."); } catch { setMessage("Copy is unavailable. Select the text below and copy it manually."); } }
  async function importFile(file: File | undefined) {
    if (!file) return; if (file.size > MAX_PAYLOAD_BYTES) { setMessage("Source file must be at most 128 KiB."); return; }
    const scope = guard.current.editorScope, sequence = ++guard.current.importSequence; setBusy(true);
    try { const source = await file.text(); if (guard.current.alive && scope === guard.current.editorScope && sequence === guard.current.importSequence) editSource(source); }
    catch { if (guard.current.alive && scope === guard.current.editorScope && sequence === guard.current.importSequence) setMessage("Source file could not be read. The current draft was preserved."); }
    finally { if (guard.current.alive && scope === guard.current.editorScope && sequence === guard.current.importSequence) setBusy(false); }
  }
  function findNext() { const element = editor.current; if (!element || !search) return; const start = draft.source.indexOf(search, element.selectionEnd); const index = start >= 0 ? start : draft.source.indexOf(search); if (index < 0) { setMessage("Search text not found."); return; } element.focus(); element.setSelectionRange(index, index + search.length); }
  return <div className="min-w-0 space-y-5">
    <header className="space-y-2"><h1 className="text-2xl font-bold">Bookmarklet payloads</h1><p>Manage approved DMP, MARS review and Route Planner review-only adapters centrally. Installed bookmarks reference stable payloads; publication changes the next load. <Link href="/admin/relay-sites" className="link">Connect Temco site mappings</Link></p><p className="text-sm text-base-content/70">System administrators only. Publishing, rollback and origin/operation policy changes require strong authentication within 10 minutes. <Link href="/account/security" className="link">Account security</Link></p></header>
    {message && <p role="status" className="alert block break-words">{message}</p>}
    <nav className="min-w-0 flex flex-wrap gap-2" aria-label="Payload selection"><button className="btn btn-outline" disabled={busy} onClick={beginNew}>New payload</button>{payloads.map(payload => <button className={`btn max-w-full min-w-0 h-auto min-h-12 whitespace-normal break-all ${detail?.id === payload.id ? "btn-primary" : "btn-outline"}`} key={payload.id} disabled={busy} onClick={() => void select(payload.id)}>{payload.name}{!payload.enabled ? " · Disabled" : ""}</button>)}</nav>
    <fieldset disabled={busy} className="card min-w-0 bg-base-100 border border-base-300 p-4 space-y-4">
      <div className="grid gap-4 sm:grid-cols-2"><label className="form-control">Stable payload ID<input className="input input-bordered w-full" value={draft.id} disabled={Boolean(detail) || busy} maxLength={64} placeholder="dmp-relay" onChange={event => setField("id", event.target.value)} /></label><label className="form-control">Name<input className="input input-bordered w-full" value={draft.name} maxLength={100} onChange={event => setField("name", event.target.value)} /></label><label className="form-control">Purpose<select className="select select-bordered w-full" value={draft.purpose} onChange={event => setField("purpose", event.target.value)}>{PAYLOAD_PURPOSES.map(purpose => <option key={purpose} value={purpose}>{purpose === "dmp_relay" ? "DMP relay executor" : purpose === "mars_label_helper" ? "MARS detail / label helper" : "Route Planner review only"}</option>)}</select></label><label className="form-control">Protocol version<input className="input input-bordered w-full" value={draft.protocolVersion} readOnly /><span className="text-xs">Current application supports protocol 1.</span></label></div>
      <div className="grid gap-4 sm:grid-cols-2"><label className="form-control">Exact target origins, one per line<textarea className="textarea textarea-bordered w-full font-mono" value={draft.targetOrigins} rows={3} onChange={event => setField("targetOrigins", event.target.value)} /></label><label className="form-control">Allowed named operation contract, one per line<textarea className="textarea textarea-bordered w-full font-mono" value={draft.operationNames} rows={3} onChange={event => setField("operationNames", event.target.value)} /><span className="text-xs">This list never grants server operations or bypasses user permission.</span></label></div>
      <div className="flex flex-wrap gap-2"><button className="btn btn-outline" disabled={busy || !builtin} onClick={() => { if (builtin) { setDraft(value => ({ ...value, id: value.id || DEFAULT_DMP_PAYLOAD_ID, name: value.name || "DMP relay", purpose: "dmp_relay", targetOrigins: builtin.targetOrigins.join("\n"), source: builtin.source, operationNames: "session\ndeliveries" })); invalidatePreview(); } }}>Load current DMP executor</button><label className="btn btn-outline">Import source<input type="file" accept=".js,.txt,text/javascript,text/plain" className="sr-only" onChange={event => void importFile(event.target.files?.[0])} /></label><button className="btn btn-outline" onClick={() => downloadSource(draft.id, draft.source)}>Export draft source</button></div>
      <button className="btn btn-outline w-fit" disabled={busy || !builtinMars || Boolean(detail && detail.purpose !== "mars_label_helper")} onClick={() => { if (builtinMars) { setDraft(value => ({ ...value, id: value.id || MARS_LABEL_PAYLOAD_ID, name: value.name || "MARS detail review helper", purpose: "mars_label_helper", targetOrigins: builtinMars.targetOrigins.join("\n"), source: builtinMars.source, operationNames: "" })); invalidatePreview(); } }}>Load MARS review helper</button>
      <button className="btn btn-outline w-fit" disabled={busy || !builtinRoutePlanner || Boolean(detail && detail.purpose !== "route_planner_relay")} onClick={() => { if (builtinRoutePlanner) { setDraft(value => ({ ...value, id: value.id || "route-planner-review", name: value.name || "Route Planner review only", purpose: "route_planner_relay", targetOrigins: builtinRoutePlanner.targetOrigins.join("\n"), source: builtinRoutePlanner.source, operationNames: "" })); invalidatePreview(); } }}>Load Route Planner review helper</button>
      <div className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">Published JavaScript runs with the signed-in external page&apos;s authority. Review code and target origins before release. Static checks cannot make malicious source safe. No cookies, tokens, customer data or private notes belong in published source.</div>
      <div className="flex flex-wrap gap-2"><label className="grow min-w-0">Find in source<input className="input input-bordered w-full" value={search} onChange={event => setSearch(event.target.value)} /></label><button className="btn self-end" disabled={!search} onClick={findNext}>Find next</button><button className="btn self-end" disabled={!undo.length} onClick={() => { const previous = undo.at(-1); if (previous !== undefined) { setDraft(value => ({ ...value, source: previous })); setUndo(values => values.slice(0, -1)); invalidatePreview(); } }}>Undo edit</button></div>
      <label className="block">Source<textarea ref={editor} aria-label="Payload source" className="textarea textarea-bordered w-full min-h-80 font-mono text-xs" value={draft.source} spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={event => editSource(event.target.value)} /></label>
      <label className="block">Audit note<input className="input input-bordered w-full" value={note} maxLength={500} placeholder="Why this source or policy is changing" onChange={event => setNote(event.target.value)} /></label>
      <div className="flex flex-wrap gap-2"><button className="btn btn-primary" disabled={busy || !note.trim()} onClick={() => void save()}>Validate and save draft</button><button className="btn btn-outline" disabled={busy} onClick={() => void previewDraft()}>Validate and preview synthetic page</button><span className="self-center text-sm">{detail ? `Revision ${detail.revision}${unsaved ? " · Unsaved edits" : " · Saved draft"}` : "New unpublished draft"}</span></div>
    </fieldset>
    {preview && <section className="space-y-2"><div className="flex flex-wrap justify-between gap-2"><h2 className="font-semibold">Isolated synthetic preview</h2><button className="btn btn-sm" onClick={() => setPreview("")}>Close preview</button></div><p className="text-sm">This preview uses synthetic data without your warehouse session or relay connection. It does not verify behavior on DMP, MARS or the handheld browser.</p><iframe title="Synthetic payload preview" sandbox="allow-scripts" referrerPolicy="no-referrer" className="w-full h-80 border border-base-300 bg-white rounded-xl" srcDoc={preview} /></section>}
    <section className="card min-w-0 bg-base-100 border border-base-300 p-4 space-y-3"><h2 className="text-lg font-semibold">Source comparison</h2><p className="text-sm">{comparisonLabel} → editor · {changes.length} changed line positions. This is a line comparison, not a semantic safety check.</p><div className="max-h-80 overflow-auto space-y-2 font-mono text-xs">{changes.slice(0, 200).map(change => <div key={change.line} className="border-t border-base-300 pt-2"><p>Line {change.line}</p>{change.before !== null && <pre className="whitespace-pre-wrap break-all text-error">− {change.before}</pre>}{change.after !== null && <pre className="whitespace-pre-wrap break-all text-success">+ {change.after}</pre>}</div>)}</div>{changes.length > 200 && <p className="text-sm">Showing the first 200 changed positions. Export source to review the complete file.</p>}</section>
    {detail && <>
      <section className="card min-w-0 bg-base-100 border border-base-300 p-4 space-y-3"><h2 className="text-lg font-semibold">Publish saved draft</h2><p className="break-words">{detail.name} · {detail.enabled ? "Enabled" : "Disabled"} · {detail.publishedVersion ? `Published v${detail.publishedVersion.version}` : "No managed publication; the default DMP loader still uses the built-in executor."}</p><label className="flex items-start gap-3"><input className="checkbox mt-1" type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} /><span>I reviewed the saved source, target origins and operation contract. It contains no credentials, customer payloads or private notes.</span></label><p className="text-sm">New invocations use the publication; in-flight work must stay pinned and is never replayed. Disabling does not remove code already loaded into a browser.</p><div className="flex flex-wrap gap-2"><button className="btn btn-success" disabled={busy || unsaved || !reviewed || !note.trim()} onClick={() => void action("publish")}>Publish saved draft</button><button className="btn btn-outline" disabled={busy || !note.trim()} onClick={() => void action("enabled")}>{detail.enabled ? "Disable new loads" : "Enable payload"}</button></div></section>
      <section className="card min-w-0 bg-base-100 border border-base-300 p-4 space-y-3"><h2 className="text-lg font-semibold">Published versions and rollback</h2>{detail.versions.length ? detail.versions.map(version => <div key={version.id} className="border-t border-base-300 pt-3 space-y-1"><p className="font-semibold">v{version.version} {version.id === detail.publishedVersionId ? "· Current" : ""}</p><p className="text-sm break-words">{version.note} · {new Date(version.publishedAt).toLocaleString()}</p><p className="font-mono text-xs break-all">{version.contentHash}</p><button className="btn btn-sm btn-outline" disabled={busy} onClick={() => void viewVersion(version.id)}>Compare / select v{version.version}</button></div>) : <p>No immutable versions yet.</p>}{moreVersions && <button className="btn btn-outline" disabled={busy} onClick={() => void loadMoreVersions()}>Load older versions</button>}<button className="btn btn-warning w-full max-w-full h-auto min-h-12 whitespace-normal" disabled={busy || !versionId || versionId === detail.publishedVersionId || !note.trim()} onClick={() => void action("rollback")}>Roll published pointer back to selected version</button></section>
      {selected && <section className="card min-w-0 bg-base-100 border border-base-300 p-4 space-y-3"><h2 className="text-lg font-semibold">Install or update the loader</h2><p className="text-sm">Existing bookmarks referencing this payload ID pick up a new publication on their next invocation; reinstalling is unnecessary. Old embedded MARS bookmarks need an explicit replacement.</p><label className="block">Loader URL<input className="input input-bordered w-full text-xs" readOnly value={selected.loaderUrl} /></label><div className="flex flex-wrap gap-2"><button className="btn" disabled={busy} onClick={() => void copy(selected.bookmarklet)}>Copy bookmarklet</button><button className="btn btn-outline" disabled={busy} onClick={() => void copy(selected.loaderUrl)}>Copy loader URL</button><a className={`btn btn-outline ${targetHref ? "" : "btn-disabled"}`} href={targetHref ?? undefined} aria-disabled={!targetHref} target="_blank" rel="noopener noreferrer">Open target page</a></div><textarea aria-label="Bookmarklet text" className="textarea textarea-bordered w-full text-xs font-mono" readOnly value={selected.bookmarklet} rows={4} /><ol className="list-decimal pl-5 space-y-2 text-sm"><li>On the phone/Zebra, create or edit a browser bookmark and paste the copied bookmarklet into its URL field. A desktop bookmarks bar is not required.</li><li>Open the approved target page, sign in there, then invoke that bookmark. Follow pairing/review prompts as usual.</li><li>If the browser disallows JavaScript bookmarks, use only an explicitly approved managed-browser/snippet installation route. Opening the loader URL alone cannot inject into another tab.</li><li>A CSP, popup or connection failure is a diagnosis to fix through supported policies, never a bypass. Confirm the payload/version and the selected user connection before testing live operations.</li></ol></section>}
      <section className="card min-w-0 bg-base-100 border border-base-300 p-4 space-y-3"><h2 className="text-lg font-semibold">Publication audit</h2>{detail.audits.map(audit => <article key={audit.id} className="border-t border-base-300 pt-2 text-sm break-words"><p className="font-semibold">{audit.action} · revision {audit.revision} · {new Date(audit.createdAt).toLocaleString()}</p><p>{audit.note}</p><p className="text-xs">Actor {audit.actorUserId}{audit.versionId ? ` · Version ${audit.versionId}` : ""}</p></article>)}</section>
    </>}
  </div>;
}
