import NavBar from "@/components/NavBar";
import RouteReconsClient from "@/components/route-recon/RouteReconsClient";
import { requireAuth } from "@/lib/auth";
import { listRouteRecons } from "@/lib/route-recons";

export default async function RouteReconPage() {
  const session = await requireAuth();
  const reports = await listRouteRecons();

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-[1500px] mx-auto px-4 py-8">
        <h1 className="text-2xl font-semibold mb-1">Route Recon</h1>
        <p className="text-base-content/70 mb-6">
          Upload a pick spreadsheet to organize its items by route and prepare scannable paper reports.
        </p>
        <RouteReconsClient
          initialReports={reports.map((report) => ({
            id: report.id,
            name: report.name,
            sourceFilename: report.sourceFilename,
            routeCount: report.routeCount,
            itemCount: report._count.items,
            createdAt: report.createdAt.toISOString(),
            updatedAt: report.updatedAt.toISOString(),
            archivedAt: report.archivedAt?.toISOString() ?? null,
            createdBy: report.createdByUser?.displayName ?? null,
          }))}
        />
      </main>
    </div>
  );
}
