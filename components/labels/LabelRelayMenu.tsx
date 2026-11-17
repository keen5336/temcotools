"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { useLabelRelay } from "./LabelRelayProvider";
import { useApiRelays } from "@/components/api-relay/ApiRelayProvider";

export default function LabelRelayMenu() {
  const { settings, loaded, error, status, connected, update } = useLabelRelay();
  const api = useApiRelays();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const ready = api.status?.connections.filter(connection => connection.ready).length || 0;
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); button.current?.focus(); } };
    document.addEventListener("pointerdown", dismiss); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [open]);
  return <div ref={container} className="relative shrink-0">
    <button ref={button} type="button" className="btn btn-ghost btn-sm gap-2 px-2 sm:px-3" aria-label="Relay Mode" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(current => !current)}>
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${connected || ready ? "bg-success" : settings.enabled || api.error ? "bg-warning" : "bg-base-content/30"}`} />Relay Mode
      {ready > 0 && <span className="badge badge-xs badge-success">{ready}</span>}
    </button>
    {open && <div id={panelId} role="region" aria-label="Relay connections" className="fixed inset-x-3 top-16 z-50 max-h-[calc(100dvh-5rem)] overflow-y-auto rounded-box border border-base-300 bg-base-100 p-4 shadow-xl space-y-4 sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-80">
      <div><label className="flex items-center justify-between gap-3 cursor-pointer"><span className="font-semibold">Label Relay Mode</span><input aria-label="Label Relay Mode" type="checkbox" className="toggle toggle-success" checked={settings.enabled} disabled={!loaded || !settings.printerIds.length} onChange={event => update({ ...settings, enabled: event.target.checked })} /></label><p role="status" className="text-sm mt-2">{error || (!loaded ? "Loading printers…" : settings.enabled ? status : "Off — not accepting labels")}</p></div>
      <div className="border-t border-base-200 pt-3 space-y-2"><h2 className="font-semibold">API relays</h2>
        {api.error && <p role="status" className="text-sm text-warning">{api.error}</p>}
        {!api.status && !api.error && <p className="text-sm">Checking connections…</p>}
        {api.status?.definitions.map(definition => { const connections = api.status!.connections.filter(connection => connection.relayId === definition.id); const ready = connections.filter(connection => connection.ready).length; return <div key={definition.id} className="flex justify-between gap-3 text-sm"><span>{definition.name}</span><span className={ready ? "text-success" : "text-base-content/60"}>{api.error ? "Unavailable" : ready ? `${ready} connected` : connections.length ? "Checking account…" : "Not connected"}</span></div>; })}
        {api.status && !api.status.definitions.length && <p className="text-sm">No API relays are enabled.</p>}
      </div>
      <Link href="/configuration" className="btn btn-sm btn-outline w-full" onClick={() => setOpen(false)}>Configuration & connections</Link>
    </div>}
  </div>;
}
