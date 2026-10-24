"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ApiRelayPairClient({ origin, nonce, displayName, allowed }: { origin: string; nonce: string; displayName: string | null; allowed: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function pair() {
    setBusy(true); setMessage("");
    try {
      if (!window.opener) throw new Error("Open this pairing window using Connect on the DMP tab.");
      const response = await fetch("/api/api-relay/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origin }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Pairing failed.");
      window.opener.postMessage({ type: "temco-api-relay-pair", nonce, token: result.token }, origin);
      // Refresh the shared layout so its authenticated lease starts immediately.
      router.refresh();
      setMessage("Pairing approved. Return to DMP; this window may close automatically.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Pairing failed."); setBusy(false); }
  }
  return <main className="max-w-lg mx-auto p-6 space-y-5">
    <h1 className="text-2xl font-semibold">Connect your DMP tab</h1>
    {!allowed ? <p role="alert">This DMP site is not configured, or the pairing link is invalid.</p> : <>
      <p>DMP site: <strong className="break-all">{origin}</strong></p>
      {displayName ? <><p>This connection will belong to <strong>{displayName}</strong>. DMP requests use the account signed into that DMP tab.</p><button className="btn btn-primary" disabled={busy} onClick={() => { void pair(); }}>Connect as {displayName}</button></> : <><p>Sign into Temco Tools, then return here and reload this window.</p><a className="btn btn-primary" href="/signin" target="_blank" rel="noopener noreferrer">Sign into Temco</a><button className="btn" onClick={() => location.reload()}>I’m signed in — reload</button></>}
    </>}
    {message && <p role="status">{message}</p>}
  </main>;
}
