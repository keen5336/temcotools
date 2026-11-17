"use client";

import { useEffect, useRef, useState } from "react";
import { buildTemplatePreview } from "@/lib/driver-paperwork/preview";
import { FIELD_LABELS, PAGE_LABELS, PAGE_TYPES, TEMPLATE_FIELDS, templateSchema, type PageType, type PaperworkTemplates, type RichNode } from "@/lib/driver-paperwork/templates";
import RichTextEditor from "./RichTextEditor";

type Snapshot = { version: number; template: PaperworkTemplates; program: string; operationId: string | null };
type EditorData = { current: Snapshot; selected: Snapshot | null; history: { version: number; createdAt: string; author: string }[] };
const BLOCKS = {
  coverReminders: "Cover · Driver reminders", coverAttention: "Cover · Special attention", appPod: "Cover · APP POD compliance", sthPod: "Cover · STH POD compliance",
  surveyTitle: "Survey · Heading", surveyExperience: "Survey · Delivery experience", surveyRating: "Survey · Rating explanation", surveyNotes: "Survey · Other reminders",
} as const;
type Block = keyof typeof BLOCKS;
const routeFields = ["route", "driver", "date", "miles"];
const endpoint = "/api/driver-paperwork/templates";

async function readEditor(query = ""): Promise<EditorData> {
  const response = await fetch(endpoint + query, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Templates could not be loaded.");
  return data;
}

export default function TemplateEditor() {
  const [data, setData] = useState<EditorData | null>(null);
  const [draft, setDraft] = useState<Snapshot | null>(null);
  const [tab, setTab] = useState<"visual" | "javascript">("visual");
  const [section, setSection] = useState<string>("coverReminders");
  const [editorKey, setEditorKey] = useState(0);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [preview, setPreview] = useState<{ html: string; nonce: string; fingerprint: string } | null>(null);
  const [previewResult, setPreviewResult] = useState<"pending" | "passed" | "failed">("pending");
  const [previewError, setPreviewError] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);
  const fingerprint = draft ? JSON.stringify({ template: draft.template, program: draft.program }) : "";
  const dirty = draft && data ? JSON.stringify({ template: data.current.template, program: data.current.program }) !== fingerprint : false;
  const previewCurrent = preview?.fingerprint === fingerprint;

  useEffect(() => {
    let cancelled = false;
    readEditor().then(result => { if (!cancelled) { setData(result); setDraft(result.current); } }).catch(error => { if (!cancelled) setNotice(error.message); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!preview) return;
    function receive(event: MessageEvent) {
      if (event.source !== frame.current?.contentWindow || event.data?.type !== "driver-paperwork-preview" || event.data.nonce !== preview?.nonce) return;
      setPreviewResult(event.data.error ? "failed" : "passed");
      setPreviewError(typeof event.data.error === "string" ? event.data.error : "");
    }
    window.addEventListener("message", receive);
    const timer = window.setTimeout(() => { setPreviewResult(result => result === "pending" ? "failed" : result); setPreviewError(error => error || "If the preview did not finish, check the JavaScript and preview again."); }, 20_000);
    return () => { window.removeEventListener("message", receive); window.clearTimeout(timer); };
  }, [preview]);

  async function reload() {
    setBusy(true);
    try { const result = await readEditor(); setData(result); setDraft(result.current); setEditorKey(key => key + 1); setUncertain(false); setNotice("Loaded the current saved version."); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Could not reload templates."); }
    finally { setBusy(false); }
  }
  function updateTemplate(template: PaperworkTemplates) { setDraft(current => current ? { ...current, template } : current); }
  function updateBlock(value: RichNode) {
    if (!draft) return;
    if (PAGE_TYPES.includes(section as PageType)) updateTemplate({ ...draft.template, pages: { ...draft.template.pages, [section]: { ...draft.template.pages[section as PageType], notes: value } } });
    else updateTemplate({ ...draft.template, [section]: value });
  }
  function showPreview() {
    if (!draft) return;
    const parsed = templateSchema.safeParse(draft.template);
    if (!parsed.success) { setNotice(parsed.error.issues[0]?.message || "Check the template content."); return; }
    const nonce = crypto.randomUUID(); setPreviewResult("pending"); setPreviewError("");
    setPreview({ html: buildTemplatePreview(parsed.data, draft.program, nonce), nonce, fingerprint });
  }
  async function save() {
    if (!draft || !data) return;
    setBusy(true); setNotice("");
    const operationId = crypto.randomUUID();
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: draft.version, operationId, template: draft.template, program: draft.program }) });
      const result = await response.json();
      if (!response.ok) {
        if (response.status >= 500) throw new Error(result.error);
        setNotice(result.error || "The template was not saved."); return;
      }
      setDraft(result); setData(current => current ? { ...current, current: result } : current);
      setNotice(`Saved version ${result.version}. New bookmarklet loads will use it.`);
      // Read-only reconciliation also refreshes the recent version list.
      try { const refreshed = await readEditor(); setData(current => current ? { ...current, history: refreshed.history } : current); } catch { /* Saved response already confirmed this version. */ }
    } catch {
      // A lost response is uncertain. Reconcile by operation ID; do not repeat a write.
      try {
        const check = await readEditor(`?operationId=${operationId}`);
        if (check.selected) { setData({ ...check, current: check.selected }); setDraft(check.selected); setNotice(`Confirmed saved version ${check.selected.version}.`); }
        else { setUncertain(true); setNotice("The save could not be confirmed. Reload the saved version before making another save."); }
      } catch { setUncertain(true); setNotice("The save could not be confirmed. Reload the saved version before making another save."); }
    } finally { setBusy(false); }
  }
  async function restore(version: string) {
    if (!version || !draft) return;
    setBusy(true);
    try {
      const result = await readEditor(`?version=${version}`);
      if (result.selected) {
        setData(result); setDraft({ ...result.selected, version: result.current.version }); setEditorKey(key => key + 1);
        setNotice(`Version ${version} loaded as an unsaved draft. Preview and save to publish it as a new version.`);
      }
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not load that version."); }
    finally { setBusy(false); }
  }

  if (!draft || !data) return <section className="rounded-box border border-base-300 bg-base-100 p-5"><h2 className="text-lg font-semibold">Templates &amp; payload</h2><p role="status" className="mt-3">{notice || "Loading saved templates…"}</p>{notice && <button className="btn btn-outline mt-3" onClick={() => { void reload(); }}>Reload templates</button>}</section>;
  const pageType = PAGE_TYPES.includes(section as PageType) ? section as PageType : null;
  const richValue = pageType ? draft.template.pages[pageType].notes : section in BLOCKS ? draft.template[section as Block] : null;
  return <section className="rounded-box border border-base-300 bg-base-100 p-5 space-y-4" aria-labelledby="template-heading">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 id="template-heading" className="text-lg font-semibold">Templates &amp; payload</h2><p className="text-sm text-base-content/70">Saved version {data.current.version}{dirty ? " · Unsaved changes" : ""}</p></div><button className="btn btn-sm btn-outline" disabled={busy} onClick={() => { void reload(); }}>Reload saved version</button></div>
    <p>Edit cover instructions, survey wording and the three stop templates. Insert fields to fill in route or customer details automatically. Save publishes both the templates and JavaScript for everyone using the bookmarklet.</p>
    <div className="flex gap-2" role="tablist" aria-label="Template editor mode"><button role="tab" aria-selected={tab === "visual"} className={`btn btn-sm ${tab === "visual" ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab("visual")}>Visual templates</button><button role="tab" aria-selected={tab === "javascript"} className={`btn btn-sm ${tab === "javascript" ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab("javascript")}>Advanced JavaScript</button></div>
    <div inert={busy}>
      {tab === "javascript" ? <div className="space-y-3"><p className="text-sm">This code runs in the manifest tab. Keep <code>createDriverPaperworkRuntime(config, assets)</code> and its <code>buildBooklet</code>, <code>paginate</code> and <code>mount</code> methods. The visual templates are passed as <code>config</code>; the two logos are in <code>assets.temco</code> and <code>assets.homeDepot</code>.</p><textarea className="textarea textarea-bordered w-full font-mono text-xs" aria-label="JavaScript payload" spellCheck={false} rows={24} value={draft.program} onChange={event => setDraft({ ...draft, program: event.target.value })} /></div>
      : <div className="space-y-4">
        <label className="form-control block"><span className="label-text block mb-2">Template section</span><select className="select select-bordered w-full" aria-label="Template section" value={section} onChange={event => setSection(event.target.value)}>{Object.entries(BLOCKS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}<option value="contacts">Cover · Management contacts</option>{PAGE_TYPES.map(type => <option key={type} value={type}>{PAGE_LABELS[type]} · Stop template</option>)}</select></label>
        {section === "contacts" ? <div className="grid md:grid-cols-2 gap-3">{draft.template.contacts.flatMap((row, r) => row.map((contact, c) => <div key={`${r}-${c}`} className="flex gap-2"><input className="input input-bordered min-w-0 w-1/2" aria-label={`Contact ${r * 2 + c + 1} name`} maxLength={30} value={contact.name} onChange={event => { const contacts = structuredClone(draft.template.contacts); contacts[r][c].name = event.target.value; updateTemplate({ ...draft.template, contacts }); }} /><input className="input input-bordered min-w-0 w-1/2" aria-label={`Contact ${r * 2 + c + 1} phone`} maxLength={30} value={contact.phone} onChange={event => { const contacts = structuredClone(draft.template.contacts); contacts[r][c].phone = event.target.value; updateTemplate({ ...draft.template, contacts }); }} /></div>))}</div> : <>
          {pageType && <fieldset className="border border-base-300 rounded-lg p-4 space-y-3"><legend className="px-2 font-semibold">Visible fields and columns</legend><div className="flex flex-wrap gap-4">{Object.entries(FIELD_LABELS).map(([key, label]) => <label key={key} className="flex items-center gap-2"><input type="checkbox" className="checkbox checkbox-sm" checked={draft.template.pages[pageType].fields.includes(key as keyof typeof FIELD_LABELS)} onChange={event => { const current = draft.template.pages[pageType]; const fields = event.target.checked ? [...current.fields, key as keyof typeof FIELD_LABELS] : current.fields.filter(field => field !== key); updateTemplate({ ...draft.template, pages: { ...draft.template.pages, [pageType]: { ...current, fields } } }); }} />{label}</label>)}</div><div className="flex flex-wrap gap-4">{([ ["quantity", "Quantity column"], ["sku", "SKU column"], ["showRouteDate", "Route and date in header"] ] as const).map(([key, label]) => <label key={key} className="flex items-center gap-2"><input className="checkbox checkbox-sm" type="checkbox" checked={draft.template.pages[pageType][key]} onChange={event => updateTemplate({ ...draft.template, pages: { ...draft.template.pages, [pageType]: { ...draft.template.pages[pageType], [key]: event.target.checked } } })} />{label}</label>)}</div><p className="text-xs text-base-content/60">Customer, address and item descriptions always appear. Additional instructions below appear above the items.</p></fieldset>}
          {richValue && <RichTextEditor key={`${section}-${editorKey}`} value={richValue} onChange={updateBlock} label={pageType ? `${PAGE_LABELS[pageType]} instructions` : BLOCKS[section as Block]} fields={pageType ? TEMPLATE_FIELDS : routeFields} />}
        </>}
      </div>}
    </div>
    <div className="flex flex-wrap items-center gap-3"><button type="button" className="btn btn-outline" disabled={busy} onClick={showPreview}>Preview draft</button><button type="button" className="btn btn-primary" disabled={busy || uncertain || !dirty || !previewCurrent || previewResult !== "passed"} onClick={() => { void save(); }}>{busy ? "Working…" : "Save templates & code"}</button><span className="text-sm text-base-content/70">Preview the current draft before saving.</span></div>
    {notice && <p role="status" className="text-sm whitespace-pre-wrap">{notice}</p>}
    {preview && <div className="space-y-2"><p role="status" className="text-sm">{!previewCurrent ? "Draft changed · preview again before saving." : previewResult === "pending" ? "Checking the sample booklet…" : previewResult === "passed" ? "Sample preview ready · Cover, route summary and all three stop types." : `Preview needs attention: ${previewError}`}</p><div className="overflow-x-auto rounded-lg border border-base-300 bg-base-200"><iframe ref={frame} key={preview.nonce} title="Driver Paperwork template preview" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={preview.html} className="block h-[42rem] w-[840px]" /></div></div>}
    <details className="border-t border-base-300 pt-4"><summary className="cursor-pointer font-semibold">Version history &amp; restore</summary><p className="text-sm mt-3 mb-2">Load a version as a draft, then preview and save it. The most recent 50 saved versions are listed; any version can be loaded by number.</p><div className="flex flex-wrap gap-3"><select className="select select-bordered" aria-label="Restore template version" value="" disabled={busy} onChange={event => { void restore(event.target.value); }}><option value="">Choose a saved version…</option><option value="0">Original templates &amp; code</option>{data.history.map(item => <option value={item.version} key={item.version}>v{item.version} · {item.author} · {new Date(item.createdAt).toLocaleString()}</option>)}</select><form className="flex gap-2" onSubmit={event => { event.preventDefault(); const value = new FormData(event.currentTarget).get("version"); if (typeof value === "string" && /^\d{1,9}$/.test(value)) void restore(value); }}><input name="version" aria-label="Version number to restore" className="input input-bordered w-32" type="number" min="0" required placeholder="Version #" /><button className="btn btn-outline" disabled={busy}>Load version</button></form></div></details>
  </section>;
}
