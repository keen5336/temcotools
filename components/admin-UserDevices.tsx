"use client";
import { useCallback, useEffect, useState } from "react";
type Device = { id: string; kind: string; deviceName: string; createdAt: string; lastUsedAt: string; expiresAt: string; mcpGrant: { scopes: string[]; client: { name: string } } | null };
export default function UserDevices({ userId, onChange }: { userId: string; onChange: () => void }) {
  const [devices, setDevices] = useState<Device[]>([]), [current, setCurrent] = useState("");
  const [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const response = await fetch(`/api/admin/users/${userId}/devices`, { cache: "no-store" });
    const value = await response.json(); if (!response.ok) throw new Error(value.error || "Unable to load devices."); return value;
  }, [userId]);
  useEffect(() => { let active = true; void load().then(value => { if (active) { setDevices(value.devices); setCurrent(value.currentSessionId); } }).catch(error => { if (active) setMessage(error.message); }); return () => { active = false; }; }, [load]);
  async function revoke(id: string) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/admin/users/${userId}/devices`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: id }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || "Sign-out could not be confirmed. Reload devices before trying again.");
      if (result.current) { window.location.reload(); return; }
      const value = await load(); setDevices(value.devices); onChange(); setMessage("Device signed out.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Reload devices to check current state."); }
    finally { setBusy(false); }
  }
  return <fieldset className="rounded-box border border-base-300 p-4 space-y-3"><legend className="font-semibold px-2">Signed-in devices</legend>
    {message && <p role="status" className="text-sm">{message}</p>}
    {!devices.length && <p className="text-sm text-base-content/65">No active devices.</p>}
    {devices.map(device => <div key={device.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-base-200 pb-3"><div><strong>{device.deviceName}</strong>{device.id === current && " · this device"}<span className="badge badge-outline ml-2">{device.kind === "mcp" ? "MCP" : "Browser"}</span><p className="text-sm">Signed in {new Date(device.createdAt).toLocaleString()} · last active {new Date(device.lastUsedAt).toLocaleString()}</p><p className="text-sm text-base-content/65">Expires {new Date(device.expiresAt).toLocaleString()}{device.mcpGrant ? ` · ${device.mcpGrant.scopes.includes("temco.write") ? "Full app access" : "Read only"}` : ""}</p></div><button type="button" className="btn btn-sm btn-outline" disabled={busy} onClick={() => void revoke(device.id)}>Sign out device</button></div>)}
  </fieldset>;
}
