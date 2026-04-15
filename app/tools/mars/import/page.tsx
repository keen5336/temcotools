import NavBar from "@/components/NavBar";
import MarsImportClient from "@/components/mars/MarsImportClient";
import MarsNav from "@/components/mars/MarsNav";
import { requireAuth } from "@/lib/auth";
import { getLatestMarsImportBatch } from "@/lib/mars/inventory";

export default async function MarsImportPage() {
  const session = await requireAuth();
  const latestBatch = await getLatestMarsImportBatch();

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-semibold text-base-content mb-1">MARS Import</h1>
        <p className="text-base-content/70 mb-6">
          Upload the latest spreadsheet to refresh the local MARS snapshot while preserving local
          operational fields.
        </p>
        <MarsNav />
        <MarsImportClient latestBatch={latestBatch} />
      </main>
    </div>
  );
}
