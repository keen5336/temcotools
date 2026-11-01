"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LabelOutputSelector from "@/components/labels/LabelOutputSelector";
import { useLabelConfiguration } from "@/components/labels/useLabelConfiguration";
import { sendLabel } from "@/lib/label-printing";
import Link from "next/link";
import { buildMarsLabelBookmarklet } from "@/lib/mars-label-bookmarklet";
import { LabelFields, emptyLabelFields, parseFields, renderTemplate, safeField } from "./marsLabelShared";

type StatusTone = "default" | "ok" | "warn" | "error";

export default function MarsLabelClient() {
  const labels = useLabelConfiguration("mars_return");
  const [fields, setFields] = useState<LabelFields>(emptyLabelFields());
  const [sourceText, setSourceText] = useState("");
  const [status, setStatus] = useState<{ message: string; tone: StatusTone }>({ message: "Ready", tone: "default" });
  const [bookmarkletCode, setBookmarkletCode] = useState("");
  const [boundUnitId, setBoundUnitId] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const printingRef = useRef(false);
  const parseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showStatus = useCallback((message: string, tone: StatusTone = "default") => setStatus({ message, tone }), []);
  const zplOutput = useMemo(() => labels.template ? renderTemplate(labels.template.zpl, fields) : "", [labels.template, fields]);
  useEffect(() => { const timer = window.setTimeout(() => setBookmarkletCode(buildMarsLabelBookmarklet(window.location.origin)), 0); return () => window.clearTimeout(timer); }, []);

  useEffect(() => {
    const prefix = ["#mars-unit=", "#mars-fields=", "#relay-label="].find(value => window.location.hash.startsWith(value));
    if (labels.loading || !prefix) return;
    const timer = window.setTimeout(async () => {
      try {
        if (window.location.hash.length > 32 * 1024) throw new Error("The field handoff is too large.");
        const payload = JSON.parse(decodeURIComponent(window.location.hash.slice(prefix.length)));
        let incoming = payload.fields;
        if (prefix === "#mars-unit=") {
          if (typeof payload.unitId !== "string" || typeof payload.requestNumber !== "string") throw new Error("A linked physical unit and submission are required.");
          const response = await fetch(`/api/labels/units?${new URLSearchParams({ unitId: payload.unitId })}`, { cache: "no-store" });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Unit context unavailable.");
          if (data.context?.fields?.submissionNumber?.toUpperCase() !== payload.requestNumber.trim().toUpperCase()) throw new Error("The current unit does not have this unique active submission link. Review its identifier history before printing.");
          incoming = data.context.fields; setBoundUnitId(payload.unitId);
        } else setBoundUnitId(null);
        const imported = emptyLabelFields();
        for (const key of Object.keys(imported) as (keyof LabelFields)[]) {
          if (typeof incoming?.[key] === "string") imported[key] = incoming[key].slice(0, 2000);
        }
        setFields(imported);
        showStatus(prefix === "#mars-unit=" ? "Current linked unit fields loaded. Review the label and current printer mode, then print explicitly." : "MARS field hints imported. Verify each field and your current printer selection, then print explicitly.", "ok");
      } catch (error) { showStatus(error instanceof Error ? error.message : "Could not import bookmarklet fields.", "error"); }
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [labels.loading, showStatus]);

  useEffect(() => {
    if (parseTimerRef.current) clearTimeout(parseTimerRef.current);
    if (!sourceText.trim()) return;
    parseTimerRef.current = setTimeout(() => { setBoundUnitId(null); setFields(parseFields(sourceText)); showStatus("Fields parsed for manual review", "ok"); }, 120);
    return () => { if (parseTimerRef.current) clearTimeout(parseTimerRef.current); };
  }, [sourceText, showStatus]);

  async function handlePrint() {
    if (!labels.printer || !labels.template) { showStatus("Printer configuration is incomplete", "warn"); return; }
    if (printingRef.current) return;
    printingRef.current = true; setPrinting(true);
    showStatus("Sending label…", "ok");
    try {
      showStatus(await sendLabel(labels.printer, zplOutput + "\x04", labels.relayEnabled, { unitId: boundUnitId ?? undefined, reason: "Explicitly reviewed MARS label content; no upstream submission action." }), "ok");
    } catch (error) {
      showStatus(error instanceof Error ? error.message : "Unable to send label.", "error");
    } finally { printingRef.current = false; setPrinting(false); }
  }

  async function copy(value: string, success: string) {
    try { await navigator.clipboard.writeText(value); showStatus(success, "ok"); }
    catch { showStatus("Could not copy", "error"); }
  }

  const statusClass = status.tone === "ok" ? "text-success border-success" : status.tone === "error" ? "text-error border-error" : status.tone === "warn" ? "text-warning border-warning" : "text-base-content/60 border-base-300";

  return (
    <>
      <div className="grid grid-cols-1 xl:grid-cols-[1.15fr_0.95fr] gap-5 items-start">
        <div className="flex flex-col gap-5">
          <section className="card bg-base-100 border border-base-200 shadow-sm"><div className="card-body gap-4">
            <div><h2 className="card-title text-base">1) Paste source text</h2><p className="text-sm text-base-content/60 mt-1">Copy the MARS return detail page and paste it here. Fields are parsed automatically.</p></div>
            <textarea className="textarea textarea-bordered font-mono min-h-48 resize-y" spellCheck={false} placeholder="Paste the copied return page text here…" value={sourceText} onChange={(event) => setSourceText(event.target.value)} autoFocus />
          </div></section>

          <section className="card bg-base-100 border border-base-200 shadow-sm"><div className="card-body gap-4">
            <div><h2 className="card-title text-base">2) Verify fields</h2><p className="text-sm text-base-content/60 mt-1">Correct any extracted value before printing.</p></div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {([
                ["serialNumber", "Serial #"], ["dateSubmitted", "Date Submitted"], ["submissionNumber", "Submission #"], ["vendorRaNumber", "Vendor RA #"],
                ["orderNumber", "Order #"], ["vendor", "Vendor"], ["modelNumber", "Model #"], ["submittedBy", "Return Submitted By"],
              ] as Array<[keyof LabelFields, string]>).map(([id, label]) => <label key={id} className="form-control"><span className="label-text mb-1 font-semibold">{label}</span><input className="input input-bordered input-sm" value={fields[id]} maxLength={2000} onChange={(event) => { setBoundUnitId(null); setFields((current) => ({ ...current, [id]: event.target.value })); }} /></label>)}
            </div>
            <button className="btn btn-sm btn-ghost self-start" onClick={() => { setBoundUnitId(null); setFields(emptyLabelFields()); }}>Reset fields</button>
            {boundUnitId && <Link href={`/tools/warehouse/unit/${encodeURIComponent(boundUnitId)}`} className="link text-sm">Open this unit&apos;s current instructions, history and managed labels</Link>}
          </div></section>

          <section className="card bg-base-100 border border-base-200 shadow-sm"><div className="card-body gap-4">
            <div><h2 className="card-title text-base">3) Label output</h2><p className="text-sm text-base-content/60 mt-1">Choose an approved template and where to print. Managers control the underlying ZPL and endpoint.</p></div>
            <LabelOutputSelector printers={labels.printers} templates={labels.templates} printerId={labels.printerId} templateId={labels.templateId} onPrinterChange={labels.setPrinterId} onTemplateChange={labels.setTemplateId} loading={labels.loading} error={labels.error} />
            <div className="flex gap-2 flex-wrap"><button className="btn btn-sm btn-success" onClick={handlePrint} disabled={printing || !labels.printer || !labels.template}>{printing ? "Sending…" : "Print label"}</button><button className="btn btn-sm" onClick={() => copy(zplOutput, "ZPL copied")} disabled={!zplOutput}>Copy ZPL</button></div>
          </div></section>

          <section className="card bg-base-100 border border-base-200 shadow-sm"><div className="card-body gap-4">
            <div><h2 className="card-title text-base">4) MARS detail helper bookmarklet</h2><p className="text-sm text-base-content/60 mt-1">The stable loader opens extracted field hints in signed-in TemcoTools for review. It carries no printer, template or source code, and never prints from the external page.</p></div>
            <textarea className="textarea textarea-bordered font-mono text-xs min-h-36 bg-base-200" readOnly value={bookmarkletCode} />
            <button className="btn btn-sm btn-primary self-start" onClick={() => copy(bookmarkletCode, "Bookmarklet copied")} disabled={!bookmarkletCode}>Copy bookmarklet</button>
            <p className="text-sm">On a phone or Zebra, create a browser bookmark, edit its URL, and paste this full bookmarklet. Run it from the bookmarks menu on a MARS submission-detail page. If the review tab is blocked, tap the visible review link on that page.</p>
            <p className="text-sm text-warning">Replace old standalone bookmarks once. They contain their own cached code and cannot be remotely updated or revoked. This new loader uses centrally published payload updates on its next invocation.</p>
          </div></section>
        </div>

        <div className="flex flex-col gap-5">
          <section className="card bg-base-100 border border-base-200 shadow-sm"><div className="card-body gap-4">
            <div><h2 className="card-title text-base">Live label preview</h2><p className="text-sm text-base-content/60 mt-1">The printer uses the selected managed ZPL template.</p></div>
            <div className="rounded-xl border border-base-300 bg-white text-[#111] p-4 w-full max-w-sm" style={{ aspectRatio: "4 / 3", overflow: "hidden" }}>
              <div className="text-xs font-black uppercase text-[#555]">Serial</div><div className="text-2xl font-black mb-3 break-words">{safeField(fields.serialNumber)}</div>
              <div className="grid grid-cols-2 gap-2 mb-3"><div className="bg-[#f4f6fb] rounded p-2"><div className="text-xs uppercase">Submission</div><strong>{safeField(fields.submissionNumber)}</strong></div><div className="bg-[#f4f6fb] rounded p-2"><div className="text-xs uppercase">Date</div><strong>{safeField(fields.dateSubmitted)}</strong></div></div>
              <div className="grid grid-cols-2 gap-2 text-xs">{[["Order", fields.orderNumber], ["Vendor", fields.vendor], ["Model", fields.modelNumber], ["Submitted By", fields.submittedBy], ["Vendor RA", fields.vendorRaNumber]].map(([key, value]) => <div key={key}><div className="uppercase text-[#666]">{key}</div><strong>{safeField(value)}</strong></div>)}</div>
            </div>
            <div className="grid grid-cols-2 gap-3"><div className="bg-base-200 rounded p-3"><div className="text-xs text-base-content/50">TEMPLATE</div><strong className="text-sm">{labels.template?.name ?? "Unavailable"}</strong></div><div className="bg-base-200 rounded p-3"><div className="text-xs text-base-content/50">WHERE TO PRINT</div><strong className="text-sm">{labels.printer?.name ?? "Unavailable"}</strong></div></div>
          </div></section>
          <section className="card bg-base-100 border border-base-200 shadow-sm"><div className="card-body gap-3"><h2 className="card-title text-base">Rendered ZPL</h2><textarea className="textarea textarea-bordered font-mono text-xs min-h-72 bg-base-200" readOnly value={zplOutput} /></div></section>
        </div>
      </div>
      <div className="sticky bottom-0 z-40 mt-5 px-4 py-3 border border-base-200 rounded-t-2xl bg-base-100/95 backdrop-blur flex items-center justify-between gap-3 shadow-[0_-10px_30px_rgba(0,0,0,0.12)]"><div><div className="text-sm font-black">Review before printing</div><div className="text-xs text-base-content/50">{labels.template?.name ?? "No template"} → {labels.printer?.name ?? "No printer configured"}</div></div><button className="btn btn-sm btn-success" onClick={handlePrint} disabled={printing || !labels.printer || !labels.template}>{printing ? "Sending…" : "Print label"}</button></div>
      <div role="status" aria-live="polite" className={`fixed top-16 right-4 z-50 max-w-[calc(100vw-2rem)] sm:max-w-md border rounded-xl bg-base-100 shadow-lg px-3 py-2 text-sm font-semibold ${statusClass}`}>{status.message}</div>
    </>
  );
}
