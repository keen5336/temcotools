"use client";

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_TEMPLATE_ZPL } from "@/app/tools/rtv-label/marsLabelShared";
import { DEFAULT_PICK_WAVE_TEMPLATE } from "@/components/pick-waves/pickWaveLabel";
import type { LabelTemplateKindValue } from "@/lib/label-configuration";

interface Printer {
  id: string;
  name: string;
  endpoint: string;
  contentType: string;
  isActive: boolean;
}

interface Template {
  id: string;
  name: string;
  kind: LabelTemplateKindValue;
  zpl: string;
  isActive: boolean;
  isDefault: boolean;
}

interface Configuration { printers: Printer[]; templates: Template[] }

const emptyPrinter = { name: "", endpoint: "", contentType: "text/plain" };

export default function LabelConfigurationClient() {
  const [configuration, setConfiguration] = useState<Configuration>({ printers: [], templates: [] });
  const [printerDrafts, setPrinterDrafts] = useState<Record<string, Printer>>({});
  const [templateDrafts, setTemplateDrafts] = useState<Record<string, Template>>({});
  const [newPrinter, setNewPrinter] = useState(emptyPrinter);
  const [newTemplate, setNewTemplate] = useState({ name: "", kind: "mars_return" as LabelTemplateKindValue, zpl: DEFAULT_TEMPLATE_ZPL });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/management/label-config", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to load label configuration.");
    setConfiguration(data);
    setPrinterDrafts(Object.fromEntries(data.printers.map((item: Printer) => [item.id, item])));
    setTemplateDrafts(Object.fromEntries(data.templates.map((item: Template) => [item.id, item])));
  }, []);

  useEffect(() => {
    load().catch((error) => setMessage(error instanceof Error ? error.message : "Unable to load label configuration."));
  }, [load]);

  async function send(method: "POST" | "PATCH", body: Record<string, unknown>) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/management/label-config", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to save configuration.");
      await load();
      setMessage("Configuration saved.");
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to save configuration.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addPrinter(event: React.FormEvent) {
    event.preventDefault();
    if (await send("POST", { resource: "printer", ...newPrinter })) setNewPrinter(emptyPrinter);
  }

  async function addTemplate(event: React.FormEvent) {
    event.preventDefault();
    if (await send("POST", { resource: "template", ...newTemplate })) {
      setNewTemplate({ name: "", kind: "mars_return", zpl: DEFAULT_TEMPLATE_ZPL });
    }
  }

  function setNewKind(kind: LabelTemplateKindValue) {
    setNewTemplate({ name: "", kind, zpl: kind === "mars_return" ? DEFAULT_TEMPLATE_ZPL : DEFAULT_PICK_WAVE_TEMPLATE });
  }

  return (
    <div className="space-y-8">
      {message && <div role="status" className="alert alert-info"><span>{message}</span></div>}

      <section className="card bg-base-100 border border-base-200 shadow-sm">
        <div className="card-body">
          <div>
            <h2 className="card-title">Where to print</h2>
            <p className="text-sm text-base-content/60">Only active destinations appear in operator tools.</p>
          </div>
          <div className="space-y-3">
            {configuration.printers.length === 0 && <p className="text-sm text-warning">No printer destination is configured. Operator printing is disabled.</p>}
            {configuration.printers.map((printer) => {
              const draft = printerDrafts[printer.id] ?? printer;
              return (
                <div key={printer.id} className="grid gap-2 rounded-lg border border-base-200 p-3 md:grid-cols-[1fr_2fr_11rem_auto_auto]">
                  <input aria-label="Printer name" className="input input-bordered input-sm" value={draft.name} onChange={(e) => setPrinterDrafts((all) => ({ ...all, [printer.id]: { ...draft, name: e.target.value } }))} />
                  <input aria-label="Printer endpoint" className="input input-bordered input-sm" type="url" value={draft.endpoint} onChange={(e) => setPrinterDrafts((all) => ({ ...all, [printer.id]: { ...draft, endpoint: e.target.value } }))} />
                  <select aria-label="Content type" className="select select-bordered select-sm" value={draft.contentType} onChange={(e) => setPrinterDrafts((all) => ({ ...all, [printer.id]: { ...draft, contentType: e.target.value } }))}>
                    <option value="text/plain">text/plain</option><option value="application/octet-stream">application/octet-stream</option>
                  </select>
                  <label className="label cursor-pointer gap-2 justify-start"><input type="checkbox" className="toggle toggle-sm" checked={draft.isActive} onChange={(e) => setPrinterDrafts((all) => ({ ...all, [printer.id]: { ...draft, isActive: e.target.checked } }))} /><span>Active</span></label>
                  <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => send("PATCH", { resource: "printer", ...draft })}>Save</button>
                </div>
              );
            })}
          </div>
          <form onSubmit={addPrinter} className="grid gap-2 rounded-lg bg-base-200 p-3 md:grid-cols-[1fr_2fr_11rem_auto]">
            <input required className="input input-bordered input-sm" placeholder="Destination name" value={newPrinter.name} onChange={(e) => setNewPrinter((item) => ({ ...item, name: e.target.value }))} />
            <input required className="input input-bordered input-sm" type="url" placeholder="http://printer-bridge:3000" value={newPrinter.endpoint} onChange={(e) => setNewPrinter((item) => ({ ...item, endpoint: e.target.value }))} />
            <select className="select select-bordered select-sm" value={newPrinter.contentType} onChange={(e) => setNewPrinter((item) => ({ ...item, contentType: e.target.value }))}><option value="text/plain">text/plain</option><option value="application/octet-stream">application/octet-stream</option></select>
            <button className="btn btn-secondary btn-sm" disabled={busy}>Add destination</button>
          </form>
        </div>
      </section>

      <section className="card bg-base-100 border border-base-200 shadow-sm">
        <div className="card-body">
          <div><h2 className="card-title">Label templates</h2><p className="text-sm text-base-content/60">Templates are separated by workflow. Operators only choose among active templates.</p></div>
          <div className="space-y-4">
            {configuration.templates.map((template) => {
              const draft = templateDrafts[template.id] ?? template;
              return (
                <details key={template.id} className="rounded-lg border border-base-200 p-3" open={configuration.templates.length <= 2}>
                  <summary className="cursor-pointer font-semibold">{template.name} <span className="badge badge-ghost badge-sm ml-2">{template.kind === "mars_return" ? "MARS return" : "Pick Wave"}</span>{template.isDefault && <span className="badge badge-primary badge-sm ml-2">default</span>}</summary>
                  <div className="mt-4 space-y-3">
                    <div className="grid gap-3 md:grid-cols-2">
                      <label className="form-control"><span className="label-text mb-1">Name</span><input className="input input-bordered input-sm" value={draft.name} onChange={(e) => setTemplateDrafts((all) => ({ ...all, [template.id]: { ...draft, name: e.target.value } }))} /></label>
                      <label className="form-control"><span className="label-text mb-1">Workflow</span><select className="select select-bordered select-sm" value={draft.kind} onChange={(e) => setTemplateDrafts((all) => ({ ...all, [template.id]: { ...draft, kind: e.target.value as LabelTemplateKindValue } }))}><option value="mars_return">MARS return</option><option value="pick_wave">Pick Wave</option></select></label>
                    </div>
                    <textarea aria-label="ZPL template" className="textarea textarea-bordered min-h-72 w-full font-mono text-xs" value={draft.zpl} onChange={(e) => setTemplateDrafts((all) => ({ ...all, [template.id]: { ...draft, zpl: e.target.value } }))} spellCheck={false} />
                    <div className="flex flex-wrap items-center gap-4"><label className="label cursor-pointer gap-2"><input type="checkbox" className="toggle toggle-sm" checked={draft.isActive} onChange={(e) => setTemplateDrafts((all) => ({ ...all, [template.id]: { ...draft, isActive: e.target.checked } }))} />Active</label><label className="label cursor-pointer gap-2"><input type="checkbox" className="checkbox checkbox-sm" checked={draft.isDefault} onChange={(e) => setTemplateDrafts((all) => ({ ...all, [template.id]: { ...draft, isDefault: e.target.checked } }))} />Default for workflow</label><button className="btn btn-primary btn-sm ml-auto" disabled={busy} onClick={() => send("PATCH", { resource: "template", ...draft })}>Save template</button></div>
                  </div>
                </details>
              );
            })}
          </div>
          <form onSubmit={addTemplate} className="space-y-3 rounded-lg bg-base-200 p-3">
            <h3 className="font-semibold">Add template</h3>
            <div className="grid gap-3 md:grid-cols-2"><input required className="input input-bordered input-sm" placeholder="Template name" value={newTemplate.name} onChange={(e) => setNewTemplate((item) => ({ ...item, name: e.target.value }))} /><select className="select select-bordered select-sm" value={newTemplate.kind} onChange={(e) => setNewKind(e.target.value as LabelTemplateKindValue)}><option value="mars_return">MARS return</option><option value="pick_wave">Pick Wave</option></select></div>
            <textarea required className="textarea textarea-bordered min-h-72 w-full font-mono text-xs" value={newTemplate.zpl} onChange={(e) => setNewTemplate((item) => ({ ...item, zpl: e.target.value }))} spellCheck={false} />
            <button className="btn btn-secondary btn-sm" disabled={busy}>Add template</button>
          </form>
        </div>
      </section>
    </div>
  );
}
