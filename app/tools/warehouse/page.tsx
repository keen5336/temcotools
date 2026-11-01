import NavBar from "@/components/NavBar";
import WarehouseLookupClient from "@/components/warehouse/WarehouseLookupClient";
import { requireAuth } from "@/lib/auth";

export default async function WarehouseLookupPage() {
  const session = await requireAuth();
  return <div className="min-h-screen bg-base-200">
    <NavBar session={session} />
    <main className="mx-auto max-w-4xl px-3 py-6 sm:px-6"><WarehouseLookupClient /></main>
  </div>;
}
