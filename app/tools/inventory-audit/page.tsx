import NavBar from "@/components/NavBar";
import InventoryAuditClient from "@/components/inventory-audit/InventoryAuditClient";
import { requireAuth } from "@/lib/auth";

export default async function InventoryAuditPage() {
  const session = await requireAuth();
  return <div className="min-h-screen bg-base-200">
    <NavBar session={session} />
    <main className="max-w-[1800px] mx-auto px-4 py-8"><InventoryAuditClient /></main>
  </div>;
}
