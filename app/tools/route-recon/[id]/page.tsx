import { notFound } from "next/navigation";
import NavBar from "@/components/NavBar";
import RouteReconWorkspaceClient from "@/components/route-recon/RouteReconWorkspaceClient";
import { requireCapability } from "@/lib/auth";
import { getRouteRecon } from "@/lib/route-recons";
import { pilotPolicy } from "@/scripts/pilot-policy.mjs";

export default async function RouteReconReportPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireCapability("workflow.read");
  const { id } = await params;
  const report = await getRouteRecon(id);
  if (!report) notFound();

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-[1500px] mx-auto px-4 py-8">
        <RouteReconWorkspaceClient
          printingAllowed={pilotPolicy().permitsLivePrinting}
          initialReport={{
            ...report,
            createdAt: report.createdAt.toISOString(),
            updatedAt: report.updatedAt.toISOString(),
            archivedAt: report.archivedAt?.toISOString() ?? null,
            createdBy: report.createdByUser?.displayName ?? null,
          }}
        />
      </main>
    </div>
  );
}
