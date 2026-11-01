import NavBar from "@/components/NavBar";
import WarehouseLookupClient from "@/components/warehouse/WarehouseLookupClient";
import { getPrincipal, requireCapability } from "@/lib/auth";
import { lookupWarehouseInventory } from "@/lib/warehouse-lookup";

export default async function WarehouseLookupPage({ searchParams }: { searchParams: Promise<{ lpn?: string }> }) {
  const session = await requireCapability("inventory.read");
  const { lpn } = await searchParams;
  const initialLpn = typeof lpn === "string" && lpn.trim() && lpn.length <= 500 ? lpn : undefined;
  const principal = await getPrincipal();
  const initialResult = initialLpn && principal?.capabilities.includes("inventory.read") ? await lookupWarehouseInventory(principal, { kind: "lpn", value: initialLpn }) : undefined;
  return <div className="min-h-screen bg-base-200">
    <NavBar session={session} />
    <main className="mx-auto max-w-4xl px-3 py-6 sm:px-6"><WarehouseLookupClient key={initialLpn ?? "empty"} initialLpn={initialLpn} initialResult={initialResult} /></main>
  </div>;
}
