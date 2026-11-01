import NavBar from "@/components/NavBar";
import WarehouseIdentityClient from "@/components/warehouse/WarehouseIdentityClient";
import { getPrincipal, requireCapability } from "@/lib/auth";

export default async function WarehouseIdentitiesPage() {
  const session = await requireCapability("inventory.read");
  const principal = await getPrincipal();
  return <div className="min-h-screen bg-base-200"><NavBar session={session} /><main className="mx-auto max-w-4xl px-3 py-6 sm:px-6"><WarehouseIdentityClient canIdentify={Boolean(principal?.capabilities.includes("inventory.identify"))} /></main></div>;
}
