import { notFound } from "next/navigation";
import NavBar from "@/components/NavBar";
import RouteReconWorkspaceClient from "@/components/route-recon/RouteReconWorkspaceClient";
import { requireAuth } from "@/lib/auth";
import { getRouteRecon } from "@/lib/route-recons";

export default async function RouteReconReportPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAuth();
  const { id } = await params;
  const report = await getRouteRecon(id);
  if (!report) notFound();

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-[1500px] mx-auto px-4 py-8">
        <RouteReconWorkspaceClient
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
