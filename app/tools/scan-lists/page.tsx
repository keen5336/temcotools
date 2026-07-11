import NavBar from "@/components/NavBar";
import ScanListsClient from "@/components/scan-lists/ScanListsClient";
import { requireAuth } from "@/lib/auth";
import { listScanLists } from "@/lib/scan-lists";

export default async function ScanListsPage() {
  const session = await requireAuth();
  const lists = await listScanLists();

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-[1400px] mx-auto px-4 py-8">
        <h1 className="text-2xl font-semibold mb-1">Scan Lists</h1>
        <p className="text-base-content/70 mb-6">
          Create a named local session, capture scans, then save the finished list to the database.
        </p>
        <ScanListsClient
          initialLists={lists.map((list) => ({
            id: list.id,
            name: list.name,
            createdAt: list.createdAt.toISOString(),
            updatedAt: list.updatedAt.toISOString(),
            closedAt: list.closedAt?.toISOString() ?? null,
            archivedAt: list.archivedAt?.toISOString() ?? null,
            createdBy: list.createdByUser?.displayName ?? null,
            itemCount: list._count.items,
          }))}
        />
      </main>
    </div>
  );
}
