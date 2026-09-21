"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useLabelRelay } from "./LabelRelayProvider";

export default function LabelRelayMenu() {
  const relay = useLabelRelay();
  const { settings, printers, loaded, error, status, connected, receipts, update } = relay;
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); button.current?.focus(); }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [open]);

  return <div ref={container} className="relative shrink-0">
    <button ref={button} type="button" className="btn btn-ghost btn-sm gap-2 px-2 sm:px-3" aria-label="Label Relay Mode" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((current) => !current)}>
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${connected ? "bg-success" : settings.enabled ? "bg-warning" : "bg-base-content/30"}`} />
      Relay Mode
      <span className="sr-only">{settings.enabled ? connected ? "on" : "connecting" : "off"}</span>
    </button>
    {open && <div id={panelId} role="region" aria-label="Label relay settings" className="fixed inset-x-3 top-16 z-50 max-h-[calc(100dvh-5rem)] overflow-y-auto rounded-box border border-base-300 bg-base-100 p-4 shadow-xl space-y-4 sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-80">
      <label className="flex items-center justify-between gap-3 cursor-pointer">
        <span className="font-semibold">Label Relay Mode</span>
        <input type="checkbox" className="toggle toggle-success" checked={settings.enabled} disabled={!loaded || !settings.printerIds.length} onChange={(event) => update({ ...settings, enabled: event.target.checked })} />
      </label>
      <p role="status" className={`text-sm ${connected ? "text-success" : settings.enabled || error ? "text-warning" : "text-base-content/70"}`}>
        {error || (!loaded ? "Loading printers…" : settings.enabled ? status : "Off — this laptop is not accepting labels")}
      </p>
      <label className="form-control block"><span className="label-text mb-1 block font-semibold">Laptop name</span><input className="input input-bordered w-full" maxLength={80} value={settings.name} disabled={!loaded || settings.enabled} onChange={(event) => update({ ...settings, name: event.target.value })} /></label>
      <fieldset className="space-y-2" disabled={!loaded || settings.enabled}>
        <legend className="font-semibold text-sm mb-2">Printers this laptop can reach</legend>
        {printers.map((printer) => <label key={printer.id} className="flex gap-3 items-center cursor-pointer text-sm"><input type="checkbox" className="checkbox checkbox-sm checkbox-primary shrink-0" checked={settings.printerIds.includes(printer.id)} onChange={(event) => update({ ...settings, printerIds: event.target.checked ? [...settings.printerIds, printer.id] : settings.printerIds.filter((id) => id !== printer.id) })} /><span className="break-words min-w-0">{printer.name}</span></label>)}
        {loaded && !printers.length && <p className="text-sm text-warning">A manager must activate a printer in Label Configuration first.</p>}
      </fieldset>
      {!settings.enabled && <button type="button" className="btn btn-ghost btn-xs" onClick={relay.reload}>{error ? "Try again" : "Refresh printers"}</button>}
      <p className="text-xs text-base-content/70">Relay stays on as you use other tools or close this menu. Keep TemcoTools open and the laptop awake on the printer network. Settings are saved on this device.</p>
      {settings.enabled && <p className="text-xs text-base-content/60">Turn relay mode off to change the laptop name or printers.</p>}
      {receipts.length > 0 && <details className="border-t border-base-200 pt-3 text-sm">
        <summary className="cursor-pointer font-semibold">Recent labels ({receipts.length})</summary>
        <ul className="mt-2 space-y-2">{receipts.map((item) => <li key={item.id} className={`rounded-lg border p-2 ${item.ok ? "border-success" : "border-warning"}`}><div className="font-semibold">{item.printer} <span className="text-xs font-normal">{item.time}</span></div><p className="text-xs">{item.message}</p></li>)}</ul>
      </details>}
    </div>}
  </div>;
}
