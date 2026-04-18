import NavBar from "@/components/NavBar";
import MarsInventoryClient from "@/components/mars/MarsInventoryClient";
import MarsNav from "@/components/mars/MarsNav";
import { requireAuth } from "@/lib/auth";
import { listMarsUnits } from "@/lib/mars/inventory";

export default async function MarsInventoryPage() {
  const session = await requireAuth();
  const initialResponse = await listMarsUnits({
    page: 1,
    limit: 25,
    returnStatusMode: "exclude_received",
  });

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-[1400px] mx-auto px-4 py-8">
        <h1 className="text-2xl font-semibold text-base-content mb-1">MARS Inventory</h1>
        <p className="text-base-content/70 mb-6">
          Browse the latest imported MARS units, filter and sort the working inventory, and manage
          local staged state. Received return-status items are hidden by default.
        </p>
        <MarsNav />
        <MarsInventoryClient initialResponse={{ ok: true, ...initialResponse }} />
      </main>
    </div>
  );
}
