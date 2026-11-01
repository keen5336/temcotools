import NavBar from "@/components/NavBar";
import WarehouseImportClient from "@/components/warehouse/WarehouseImportClient";
import { requireCapability } from "@/lib/auth";

export default async function WarehouseImportPage() {
  const session = await requireCapability("inventory.read");
  return <div className="min-h-screen bg-base-200"><NavBar session={session} /><main className="mx-auto max-w-3xl px-3 py-6 sm:px-6"><WarehouseImportClient /></main></div>;
}
