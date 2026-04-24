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
          Focus on the working inventory by default. Archived units stay out of the main view
          unless you explicitly switch to them, and the default filter favors units that still need
          attention.
        </p>
        <MarsNav />
        <MarsInventoryClient initialResponse={{ ok: true, ...initialResponse }} />
      </main>
    </div>
  );
}
