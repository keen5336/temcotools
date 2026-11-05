"use client";
import Link from "next/link";
import { useState } from "react";
import { connectionCommand } from "@/lib/integrations/client";
import { WMS_LPN_FIXTURE, WMS_LPN_SAMPLE, WMS_LPN_OUTPUT } from "@/lib/integrations/wms-lpn-fixture";

export default function WmsReadSetup({ canPreview }: { canPreview: boolean }) {
  const [busy, setBusy] = useState(false), [result, setResult] = useState(""), [error, setError] = useState("");
  async function preview() {
    if (busy) return;
    setBusy(true); setResult(""); setError("");
    try {
      const value = await connectionCommand("integrations.preview", { definition: WMS_LPN_FIXTURE, input: WMS_LPN_SAMPLE, output: WMS_LPN_OUTPUT });
      setResult(JSON.stringify(value, null, 2));
    } catch (e) { setError(e instanceof Error ? e.message : "Fixture preview unavailable."); }
    finally { setBusy(false); }
  }
  return <section id="wms-read-setup" className="border border-base-300 rounded-xl p-4 space-y-3">
    <h2 className="font-bold">WMS LPN inquiry · setup</h2>
    <p>Goal: one read of a known LPN from the original signed-in WMS browser tab. No Descartes browser inquiry, identity or warehouse contract is bundled. A signed-in screen or native FMHH app alone does not establish one.</p>
    <ol className="list-decimal pl-5 space-y-2">
      <li><strong>Identify the browser read.</strong> In WMS, open the LPN inquiry screen and look up one known LPN. Provide its screen/action name, exact origin + pathname (no query/fragment), request method/path and sanitized parameter names, and private body-only response with capture time. Also provide the existing read that identifies the signed-in person and warehouse. Never send cookies, headers, tokens, HAR or copied sessions.</li>
      <li><strong>Review and configure.</strong> A platform admin approves the evidenced identity and LPN READ action versions, publishes the generic provider payload and exact page mapping in <Link href="/admin/payloads" className="link">Payloads</Link>, registers a provider below, then pins its identity fields, upstream warehouse and action versions. Fresh password + MFA is required. Fixture approval cannot become live qualification.</li>
      <li><strong>Connect the original tab.</strong> Its human signs into WMS and runs Connect TemcoTools, then approves the exact warehouse/provider in the pairing popup. Keep that tab open. Transport connected, identity verified and action ready are separate states. An MCP client or another session needs an explicit named-read share.</li>
      <li><strong>Verify one read below.</strong> Refresh status, select the original provider and approved LPN READ, enter its evidenced typed input, prepare, then dispatch once. Inspect the same operation ID until reported. Check HTTP status, declared output and the requested LPN/warehouse against the screen. Unknown results are retained without automatic resend; a response does not establish physical presence.</li>
    </ol>
    <p>Use <Link href="/tools/dmp-samples" className="link">Private Source Samples</Link> with source “other operational export” for reviewed body-only JSON/XML/CSV. Keep source material private.</p>
    <p><strong>If inquiry exists only in native FMHH:</strong> this browser injector cannot run inside it. Provide a supported browser inquiry/export or documented approved interface first. A private body-only export can qualify fields, but cannot prove a connected live browser action.</p>
    <details><summary className="cursor-pointer min-h-11">Try the representative LPN fixture · no upstream send</summary>
      <div className="space-y-3 pt-2"><p>This validates the existing request mapper and typed response view through the shared UI/MCP service. It creates no provider, publication or operational receipt. Every endpoint and field below is invented fixture data, not a WMS mapping.</p>
        {canPreview ? <button className="btn btn-sm min-h-11" disabled={busy} onClick={() => void preview()}>{busy ? "Checking fixture…" : "Preview synthetic LPN inquiry"}</button> : <p>An administrator with integration management and inventory read access can run this preview.</p>}
        {error && <p role="alert">{error}</p>}
        {result && <div role="status"><p>Fixture validated · sent: false · live WMS unverified</p><pre aria-label="LPN fixture result" className="text-xs whitespace-pre-wrap break-all max-h-80 overflow-auto">{result}</pre></div>}
      </div>
    </details>
  </section>;
}
