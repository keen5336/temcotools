import { notFound } from "next/navigation";
import NavBar from "@/components/NavBar";
import ScanListSessionClient from "@/components/scan-lists/ScanListSessionClient";
import { requireAuth } from "@/lib/auth";
import { getScanList } from "@/lib/scan-lists";

export default async function ScanListSessionPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAuth();
  const { id } = await params;
  const scanList = await getScanList(id);
  if (!scanList) notFound();

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-6xl mx-auto px-4 py-8">
        <ScanListSessionClient
          initialList={{
            id: scanList.id,
            name: scanList.name,
            createdAt: scanList.createdAt.toISOString(),
            closedAt: scanList.closedAt?.toISOString() ?? null,
            archivedAt: scanList.archivedAt?.toISOString() ?? null,
            createdBy: scanList.createdByUser?.displayName ?? null,
            items: scanList.items.map((item) => ({
              id: item.id,
              scannedValue: item.scannedValue,
              createdAt: item.createdAt.toISOString(),
            })),
          }}
        />
      </main>
    </div>
  );
}
