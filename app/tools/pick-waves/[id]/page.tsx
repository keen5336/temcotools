import { notFound } from "next/navigation";
import NavBar from "@/components/NavBar";
import PickWaveWorkspaceClient from "@/components/pick-waves/PickWaveWorkspaceClient";
import { requireCapability } from "@/lib/auth";
import { getPickWave } from "@/lib/pick-waves";

export default async function PickWavePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireCapability("workflow.read");
  const { id } = await params;
  const wave = await getPickWave(id);
  if (!wave) notFound();
  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-[1600px] mx-auto px-4 py-8">
        <PickWaveWorkspaceClient userId={session.userId} initialWave={{
          ...wave,
          createdAt: wave.createdAt.toISOString(), updatedAt: wave.updatedAt.toISOString(), archivedAt: wave.archivedAt?.toISOString() ?? null,
          createdBy: wave.createdByUser?.displayName ?? null,
          scanCount: wave._count.scans,
          items: wave.items.map((item) => ({ ...item, scannedAt: item.scannedAt?.toISOString() ?? null })),
          scans: wave.scans.map((scan) => ({ ...scan, createdAt: scan.createdAt.toISOString() })),
        }} />
      </main>
    </div>
  );
}
