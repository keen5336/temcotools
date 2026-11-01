import { requireCapability } from "@/lib/auth";
import NavBar from "@/components/NavBar";
import Link from "next/link";
import PipelineBuilderClient from "./PipelineBuilderClient";
import { pilotPolicy } from "@/scripts/pilot-policy.mjs";

export default async function ReportEnginePage() {
  const session = await requireCapability("workflow.read");

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-5xl mx-auto px-4 py-10">
        <h1 className="text-2xl font-semibold text-base-content mb-2 print:hidden">
          Report Engine
        </h1>
        <p className="text-base-content/70 mb-8 print:hidden">
          Legacy tool pending retirement after replacement views and owner acceptance. Use shared source data and saved operational views for the v2 workflow.
        </p>
        <div className="flex flex-wrap gap-3"><Link className="btn btn-primary" href="/tools/inventory-audit">Shared WMS import and export</Link><Link className="btn btn-outline" href="/tools/lpn-put-away">Put Away</Link><Link className="btn btn-outline" href="/tools/warehouse">Unit history</Link></div>
        <div className="mt-8">{pilotPolicy().isolated ? <p className="alert">Legacy Report Engine and browser printing are disabled in this pilot. Use Private Source Samples for body-only exports.</p> : <PipelineBuilderClient />}</div>
      </main>
    </div>
  );
}
