import NavBar from "@/components/NavBar";
import MarsInventoryScreen from "@/components/mars/MarsInventoryScreen";
import { requireAuth } from "@/lib/auth";
import { getMarsOperationalOverview, listMarsUnits } from "@/lib/mars/inventory";

export default async function MarsPage() {
  const session = await requireAuth();
  const [overview, initialResponse] = await Promise.all([
    getMarsOperationalOverview(),
    listMarsUnits({
      page: 1,
      limit: 50,
      archived: false,
    }),
  ]);

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-[1400px] mx-auto px-4 py-6">
        <MarsInventoryScreen overview={overview} initialResponse={initialResponse} />
      </main>
    </div>
  );
}
