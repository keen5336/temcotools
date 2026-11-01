import { notFound } from "next/navigation";
import NavBar from "@/components/NavBar";
import WarehouseUnitClient from "@/components/warehouse/WarehouseUnitClient";
import { getPrincipal, requireCapability } from "@/lib/auth";
import { getWarehouseUnit, WarehouseCommandError } from "@/lib/warehouse/units";

export default async function WarehouseUnitPage({ params }: { params: Promise<{ unitId: string }> }) {
  const session = await requireCapability("inventory.read");
  const principal = await getPrincipal();
  if (!principal) notFound();
  const { unitId } = await params;
  const unit = await getWarehouseUnit(principal, { unitId }).catch((error) => { if (error instanceof WarehouseCommandError && error.status === 404) notFound(); throw error; });
  return <div className="min-h-screen bg-base-200"><NavBar session={session} /><main className="mx-auto max-w-4xl px-3 py-6 sm:px-6"><WarehouseUnitClient initial={unit} canIdentify={principal.capabilities.includes("inventory.identify")} /></main></div>;
}
