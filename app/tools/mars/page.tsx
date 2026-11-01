import NavBar from "@/components/NavBar";
import MarsInventoryScreen from "@/components/mars/MarsInventoryScreen";
import { requireMarsPage } from "@/lib/mars/page";
import { getMarsOverview, listMarsInventory } from "@/lib/mars/service";

export default async function MarsPage() {
  const { session, principal } = await requireMarsPage();
  const [overview, initialResponse] = await Promise.all([
    getMarsOverview(principal),
    listMarsInventory(principal, {
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
