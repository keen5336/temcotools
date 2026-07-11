import NavBar from "@/components/NavBar";
import PickWavesClient from "@/components/pick-waves/PickWavesClient";
import { requireAuth } from "@/lib/auth";
import { listPickWaves } from "@/lib/pick-waves";

export default async function PickWavesPage() {
  const session = await requireAuth();
  const waves = await listPickWaves();
  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-[1500px] mx-auto px-4 py-8">
        <h1 className="text-2xl font-semibold mb-1">Pick Waves</h1>
        <p className="text-base-content/70 mb-6">Upload a pick spreadsheet, map routes to staging locations, then scan and label each item.</p>
        <PickWavesClient initialWaves={waves.map((wave) => ({
          id: wave.id, name: wave.name, sourceFilename: wave.sourceFilename,
          createdAt: wave.createdAt.toISOString(), updatedAt: wave.updatedAt.toISOString(), archivedAt: wave.archivedAt?.toISOString() ?? null,
          createdBy: wave.createdByUser?.displayName ?? null, itemCount: wave._count.items, scannedCount: wave.items.length,
          routeCount: wave._count.routeMappings, scanCount: wave._count.scans,
        }))} />
      </main>
    </div>
  );
}
