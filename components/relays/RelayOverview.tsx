"use client";

import Link from "next/link";
import { useApiRelays } from "@/components/api-relay/ApiRelayProvider";
import { useLabelRelay } from "@/components/labels/LabelRelayProvider";

export default function RelayOverview() {
  const api = useApiRelays(); const label = useLabelRelay();
  return <section aria-label="Your relay connections" className="mb-6 rounded-box border border-base-300 bg-base-100 p-4 space-y-3">
    <div className="flex items-center justify-between gap-3"><h2 className="font-semibold">Your connections</h2><Link href="/configuration" className="link link-primary text-sm">Configure relays</Link></div>
    <div className="flex flex-wrap gap-2 text-sm" role="status">
      <span className={`badge ${label.connected ? "badge-success" : "badge-ghost"}`}>Label relay: {label.connected ? "connected" : label.settings.enabled ? "connecting" : "off"}</span>
      {api.status?.definitions.map(definition => <span key={definition.id} className={`badge ${api.status!.connections.some(connection => connection.relayId === definition.id && connection.ready) ? "badge-success" : "badge-ghost"}`}>{definition.name}: {api.error ? "unavailable" : api.status!.connections.some(connection => connection.relayId === definition.id && connection.ready) ? "connected" : "not connected"}</span>)}
      {!api.status && <span>{api.error || "Checking API relays…"}</span>}
    </div>
    {api.error && api.status && <p className="text-sm text-warning">{api.error}</p>}
  </section>;
}
