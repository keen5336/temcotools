"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { listWarehouseUnitNotes, getWarehouseUnitNote } from "@/lib/warehouse/notes";

type Note = Awaited<ReturnType<typeof listWarehouseUnitNotes>>["notes"][number];
type History = Awaited<ReturnType<typeof getWarehouseUnitNote>>;
type Pending = { method: "POST" | "PATCH"; input: Record<string, unknown> };
type Editing = { note: Note; action: "correct" | "tombstone" | "restore"; body: string; reason: string };
type Props = { unitId: string; userId: string; canWrite: boolean; canCorrectOthers: boolean };
const when = (value: string) => new Date(value).toLocaleString();

export default function UnitNotesClient(props: Props) { return <UnitNotesWorkspace key={`${props.unitId}:${props.userId}`} {...props} />; }
function UnitNotesWorkspace({ unitId, userId, canWrite, canCorrectOthers }: Props) {
  const [notes, setNotes] = useState<Note[]>([]), [nextAfterId, setNextAfterId] = useState<string | null>(null), [loaded, setLoaded] = useState(false);
  const [history, setHistory] = useState<Record<string, History>>({}), [body, setBody] = useState(""), [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [pending, setPending] = useState<Pending | null>(null);
  const saving = useRef(false);
  const load = useCallback(async (afterId?: string) => {
    const response = await fetch(`/api/warehouse/notes?${new URLSearchParams({ unitId, ...(afterId ? { afterId } : {}) })}`, { cache: "no-store" });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || "Notes could not load.");
    const page = result.result as Awaited<ReturnType<typeof listWarehouseUnitNotes>>;
    setNotes((previous) => afterId ? [...new Map([...previous, ...page.notes].map((note) => [note.noteId, note])).values()] : page.notes); setNextAfterId(page.nextAfterId); setLoaded(true);
  }, [unitId]);
  useEffect(() => { const timer = window.setTimeout(() => { void load().catch((failure) => setError(failure.message)); }, 0); return () => window.clearTimeout(timer); }, [load]);
  async function viewHistory(noteId: string, beforeRevision?: number) {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/warehouse/notes?${new URLSearchParams({ noteId, ...(beforeRevision ? { beforeRevision: String(beforeRevision) } : {}) })}`, { cache: "no-store" });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || "Note history could not load.");
      const page = result.result as History;
      setHistory((previous) => ({ ...previous, [noteId]: { ...page, revisions: beforeRevision ? [...(previous[noteId]?.revisions ?? []), ...page.revisions] : page.revisions } }));
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Note history could not load."); }
    finally { setBusy(false); }
  }
  async function send(command: Pending) {
    if (saving.current) return;
    saving.current = true;
    setPending(command); setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/warehouse/notes", { method: command.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(command.input) });
      const result = await response.json();
      if (!response.ok) { if (response.status < 500) setPending(null); throw new Error(result.error || "Note could not save."); }
      const saved = result.result.note as Note;
      setNotes((previous) => previous.some((note) => note.noteId === saved.noteId) ? previous.map((note) => note.noteId === saved.noteId ? saved : note) : [saved, ...previous]);
      setHistory((previous) => { const updated = { ...previous }; delete updated[saved.noteId]; return updated; });
      setPending(null); setEditing(null); setBody(""); setNotice(saved.state === "tombstoned" ? "Note withdrawn. Original text and attribution remain in history." : `Note revision ${saved.revision} saved.`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Save result unavailable. Retry the same operation below."); }
    finally { saving.current = false; setBusy(false); }
  }
  const editingOther = editing && editing.note.authorUserId !== userId;
  return <section className="space-y-3 rounded-xl border border-base-300 bg-base-100 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">Appliance notes</h2><button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => { setError(""); void load().catch((failure) => setError(failure.message)); }}>Refresh notes</button></div>
    <p className="text-sm text-base-content/75">Notes follow this physical appliance through all linked barcodes. Use office dispositions for authorized handling or RTV instructions; writing a note does not authorize those actions.</p>
    {error && <p className="alert alert-error text-sm" role="alert">{error}</p>}{notice && <p className="alert alert-info text-sm" role="status">{notice}</p>}
    {pending && !busy && <div className="rounded-lg border border-warning p-3 space-y-2"><p className="text-sm">The save result is unconfirmed. Retry this same operation safely before starting another edit.</p><button className="btn btn-warning w-full" onClick={() => void send(pending)}>Retry the same saved operation</button></div>}
    {canWrite && !editing && <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void send({ method: "POST", input: { operationId: crypto.randomUUID(), unitId, body } }); }}><label className="form-control"><span className="label-text">Add an attributed note</span><textarea className="textarea textarea-bordered mt-1 min-h-28 w-full" value={body} onChange={(event) => setBody(event.target.value)} maxLength={4000} disabled={busy || Boolean(pending)} placeholder="Record useful appliance context. Do not put passwords or access tokens in a note." required /></label><button className="btn btn-primary w-full" disabled={busy || Boolean(pending) || !body.trim()}>Save note</button></form>}
    {editing && <form className="space-y-3 rounded-lg border border-info p-3" onSubmit={(event) => { event.preventDefault(); void send({ method: "PATCH", input: { operationId: crypto.randomUUID(), noteId: editing.note.noteId, expectedRevision: editing.note.revision, action: editing.action, ...(editing.action !== "tombstone" ? { body: editing.body } : {}), reason: editing.reason } }); }}><h3 className="font-semibold">{editing.action === "tombstone" ? "Withdraw" : editing.action === "restore" ? "Restore" : "Correct"} note · revision {editing.note.revision}</h3>{editingOther && <p className="text-sm">This is {editing.note.authorName}&apos;s note. Your office review attribution and correction reason will be recorded.</p>}{editing.action !== "tombstone" && <label className="form-control"><span className="label-text">New note text</span><textarea className="textarea textarea-bordered mt-1 min-h-28 w-full" value={editing.body} maxLength={4000} disabled={busy || Boolean(pending)} onChange={(event) => setEditing({ ...editing, body: event.target.value })} required /></label>}<label className="form-control"><span className="label-text">Reason (original text remains in history)</span><textarea className="textarea textarea-bordered mt-1 w-full" value={editing.reason} minLength={5} maxLength={2000} disabled={busy || Boolean(pending)} onChange={(event) => setEditing({ ...editing, reason: event.target.value })} required /></label><div className="flex gap-2"><button className="btn btn-primary flex-1" disabled={busy || Boolean(pending) || editing.reason.trim().length < 5 || (editing.action !== "tombstone" && !editing.body.trim())}>Save attributed revision</button><button type="button" className="btn" disabled={busy || Boolean(pending)} onClick={() => setEditing(null)}>Cancel</button></div></form>}
    {!loaded && !error && <p className="text-sm">Loading appliance notes…</p>}{loaded && !notes.length && <p className="text-sm">No notes recorded for this appliance.</p>}
    {notes.map((note) => <article key={note.noteId} className="rounded-lg border border-base-300 p-3 space-y-2"><p className="text-sm font-semibold">{note.authorName} · {when(note.createdAt)}</p>{note.state === "tombstoned" ? <p className="text-sm italic">Withdrawn by {note.updatedByName}: {note.latestReason}</p> : <p className="whitespace-pre-wrap break-words">{note.body}</p>}<p className="text-xs text-base-content/70">Revision {note.revision}{note.revision > 1 ? ` · ${note.latestAction} by ${note.updatedByName} · ${when(note.updatedAt)}` : ""}</p>{note.revision > 1 && note.state !== "tombstoned" && <p className="text-sm">Reason: {note.latestReason}</p>}
      <div className="flex flex-wrap gap-2"><button className="btn btn-sm btn-outline" disabled={busy} onClick={() => void viewHistory(note.noteId)}>{history[note.noteId] ? "Refresh history" : "View full attribution history"}</button>{canWrite && (note.authorUserId === userId || canCorrectOthers) && <><button className="btn btn-sm" disabled={busy || Boolean(pending)} onClick={() => { setEditing({ note, action: note.state === "tombstoned" ? "restore" : "correct", body: note.body, reason: "" }); setError(""); }}>{note.state === "tombstoned" ? "Restore with new revision" : "Correct note"}</button>{note.state !== "tombstoned" && <button className="btn btn-sm" disabled={busy || Boolean(pending)} onClick={() => { setEditing({ note, action: "tombstone", body: "", reason: "" }); setError(""); }}>Withdraw note</button>}</>}</div>
      {history[note.noteId] && <div className="space-y-2 border-t pt-3">{history[note.noteId].revisions.map((revision) => <div className="rounded border border-base-300 p-3 text-sm space-y-1" key={revision.revision}><p className="font-semibold">v{revision.revision} · {revision.action} · {revision.editorName} · {when(revision.createdAt)}</p>{revision.correctedOtherAuthor && <p className="text-xs">Attributed office correction of another author&apos;s note.</p>}{revision.body && <p className="whitespace-pre-wrap break-words">{revision.body}</p>}{revision.reason && <p>Reason: {revision.reason}</p>}</div>)}{history[note.noteId].nextBeforeRevision && <button className="btn btn-sm w-full" disabled={busy} onClick={() => void viewHistory(note.noteId, history[note.noteId].nextBeforeRevision!)}>Load older revisions</button>}</div>}
    </article>)}
    {nextAfterId && <button className="btn w-full" disabled={busy} onClick={() => { setError(""); void load(nextAfterId).catch((failure) => setError(failure.message)); }}>Load older notes</button>}
  </section>;
}
