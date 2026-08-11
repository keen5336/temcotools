"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LabelOutputSelector from "@/components/labels/LabelOutputSelector";
import { useLabelConfiguration } from "@/components/labels/useLabelConfiguration";
import { LabelFields, emptyLabelFields, parseFields, renderTemplate, safeField } from "./marsLabelShared";

type StatusTone = "default" | "ok" | "warn" | "error";

function bookmarkletRuntime(config: { template: string; endpoint: string; contentType: string }) {
  const urlRe = /^https:\/\/delivery-management\.homedepot\.com\/mars\/return-submissions\/detail\/(\d+)(?:[/?#].*)?$/i;
  if (!urlRe.test(window.location.href)) {
    window.alert("MARS Label bookmarklet only works on Home Depot return submission detail pages.");
    return;
  }
  const clean = (value: string) => String(value ?? "").replace(/[\^~]/g, " ").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  const text = document.body?.innerText || "";
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const after = (label: string) => {
    const index = lines.map((line) => line.toLowerCase()).lastIndexOf(label.toLowerCase());
    return index >= 0 ? lines.slice(index + 1).find(Boolean) || "" : "";
  };
  const inline = (label: string) => {
    const match = text.match(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*#?\\s*([^\\n\\r]+)", "i"));
    return match ? match[1].trim() : "";
  };
  const pathId = window.location.pathname.match(/\/(\d+)(?:\/)?$/)?.[1] || "";
  const fields: Record<string, string> = {
    orderNumber: after("Order #") || inline("Order"), vendor: after("Vendor"),
    serialNumber: after("Serial #") || inline("Serial"), modelNumber: after("Model #") || inline("Model"),
    submissionNumber: after("Submission #") || inline("Submission") || pathId,
    submittedBy: after("Return Submitted By"), vendorRaNumber: after("Vendor RA #") || inline("Vendor RA"),
    dateSubmitted: after("Date Submitted"),
  };
  const zpl = config.template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => clean(fields[key] ?? "")) + "\x04";
  window.fetch(config.endpoint, { method: "POST", headers: { "Content-Type": config.contentType }, body: zpl, mode: "no-cors", cache: "no-store" })
    .then(() => window.alert("Label sent."))
    .catch(() => window.alert("Label sent."));
}

function buildBookmarkletCode(template: string, endpoint: string, contentType: string) {
  return `javascript:(${bookmarkletRuntime.toString()})(${JSON.stringify({ template, endpoint, contentType })})`;
}

export default function MarsLabelClient() {
  const labels = useLabelConfiguration("mars_return");
  const [fields, setFields] = useState<LabelFields>(emptyLabelFields());
  const [sourceText, setSourceText] = useState("");
  const [status, setStatus] = useState<{ message: string; tone: StatusTone }>({ message: "Ready", tone: "default" });
  const parseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showStatus = useCallback((message: string, tone: StatusTone = "default") => setStatus({ message, tone }), []);
  const zplOutput = useMemo(() => labels.template ? renderTemplate(labels.template.zpl, fields) : "", [labels.template, fields]);
  const bookmarkletCode = useMemo(() => labels.template && labels.printer ? buildBookmarkletCode(labels.template.zpl, labels.printer.endpoint, labels.printer.contentType) : "", [labels.template, labels.printer]);

  useEffect(() => {
    if (parseTimerRef.current) clearTimeout(parseTimerRef.current);
    if (!sourceText.trim()) return;
    parseTimerRef.current = setTimeout(() => { setFields(parseFields(sourceText)); showStatus("Fields parsed", "ok"); }, 120);
    return () => { if (parseTimerRef.current) clearTimeout(parseTimerRef.current); };
  }, [sourceText, showStatus]);

  async function handlePrint() {
    if (!labels.printer || !labels.template) { showStatus("Printer configuration is incomplete", "warn"); return; }
    showStatus("Sending label…", "ok");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      await fetch(labels.printer.endpoint, { method: "POST", headers: { "Content-Type": labels.printer.contentType }, body: zplOutput + "\x04", mode: "no-cors", cache: "no-store", signal: controller.signal });
      showStatus("Label sent", "ok");
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) console.error("Printer Fetch Error:", error);
      showStatus("Label sent", "ok");
    } finally {
      clearTimeout(timeout);
      setTimeout(() => showStatus("Ready"), 2500);
    }
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
              ] as Array<[keyof LabelFields, string]>).map(([id, label]) => <label key={id} className="form-control"><span className="label-text mb-1 font-semibold">{label}</span><input className="input input-bordered input-sm" value={fields[id]} onChange={(event) => setFields((current) => ({ ...current, [id]: event.target.value }))} /></label>)}
            </div>
            <button className="btn btn-sm btn-ghost self-start" onClick={() => setFields(emptyLabelFields())}>Reset fields</button>
          </div></section>

          <section className="card bg-base-100 border border-base-200 shadow-sm"><div className="card-body gap-4">
            <div><h2 className="card-title text-base">3) Label output</h2><p className="text-sm text-base-content/60 mt-1">Choose an approved template and where to print. Managers control the underlying ZPL and endpoint.</p></div>
            <LabelOutputSelector printers={labels.printers} templates={labels.templates} printerId={labels.printerId} templateId={labels.templateId} onPrinterChange={labels.setPrinterId} onTemplateChange={labels.setTemplateId} loading={labels.loading} error={labels.error} />
            <div className="flex gap-2 flex-wrap"><button className="btn btn-sm btn-success" onClick={handlePrint} disabled={!labels.printer || !labels.template}>Print label</button><button className="btn btn-sm" onClick={() => copy(zplOutput, "ZPL copied")} disabled={!zplOutput}>Copy ZPL</button></div>
          </div></section>

          <section className="card bg-base-100 border border-base-200 shadow-sm"><div className="card-body gap-4">
            <div><h2 className="card-title text-base">4) Bookmarklet payload</h2><p className="text-sm text-base-content/60 mt-1">The bookmarklet uses the currently selected managed template and printer destination.</p></div>
            <textarea className="textarea textarea-bordered font-mono text-xs min-h-36 bg-base-200" readOnly value={bookmarkletCode} />
            <button className="btn btn-sm btn-primary self-start" onClick={() => copy(bookmarkletCode, "Bookmarklet copied")} disabled={!bookmarkletCode}>Copy bookmarklet</button>
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
      <div className="sticky bottom-0 z-40 mt-5 px-4 py-3 border border-base-200 rounded-t-2xl bg-base-100/95 backdrop-blur flex items-center justify-between gap-3 shadow-[0_-10px_30px_rgba(0,0,0,0.12)]"><div><div className="text-sm font-black">Ready to print</div><div className="text-xs text-base-content/50">{labels.template?.name ?? "No template"} → {labels.printer?.name ?? "No printer configured"}</div></div><button className="btn btn-sm btn-success" onClick={handlePrint} disabled={!labels.printer || !labels.template}>Print label</button></div>
      <div role="status" aria-live="polite" className={`fixed top-16 right-4 z-50 border rounded-full px-3 py-1.5 text-xs font-semibold ${statusClass}`}>{status.message}</div>
    </>
  );
}
