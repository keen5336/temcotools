"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ApiRelayPairClient({ origin, pathname, nonce, displayName, binding }: { origin: string; pathname: string; nonce: string; displayName: string | null; binding: { relayId: string; relayRevision: number; name: string } | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function pair() {
    setBusy(true); setMessage("");
    try {
      if (!window.opener || !binding) throw new Error("Open this pairing window using Connect on the external tab.");
      const response = await fetch("/api/api-relay/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origin, pathname, ...binding }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Pairing failed.");
      window.opener.postMessage({ type: "temco-api-relay-pair", nonce, token: result.token, relayId: binding.relayId, relayRevision: binding.relayRevision }, origin);
      // Refresh the shared layout so its authenticated lease starts immediately.
      router.refresh();
      setMessage("Pairing approved. Return to the external tab; this window may close automatically.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Pairing failed."); setBusy(false); }
  }
  return <main className="max-w-lg mx-auto p-6 space-y-5">
    <h1 className="text-2xl font-semibold">Connect {binding?.name || "external system"}</h1>
    {!binding ? <p role="alert">This site is not configured, or its relay configuration changed. Run Connect Temco again on the approved page.</p> : <>
      <p>Site: <strong className="break-all">{origin}{pathname}</strong></p>
      {displayName ? <><p>This connection will belong to <strong>{displayName}</strong>. Requests use the account signed into that external tab.</p><button className="btn btn-primary" disabled={busy} onClick={() => { void pair(); }}>Connect as {displayName}</button></> : <><p>Sign into Temco Tools, then return here and reload this window.</p><a className="btn btn-primary" href="/signin" target="_blank" rel="noopener noreferrer">Sign into Temco</a><button className="btn" onClick={() => location.reload()}>I’m signed in — reload</button></>}
    </>}
    {message && <p role="status">{message}</p>}
  </main>;
}
