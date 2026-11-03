import { notFound } from "next/navigation";
import NavBar from "@/components/NavBar";
import WarehouseUnitClient from "@/components/warehouse/WarehouseUnitClient";
import { getPrincipal, requireCapability } from "@/lib/auth";
import { getWarehouseUnit, WarehouseCommandError } from "@/lib/warehouse/units";
import { getUnitLabelContext } from "@/lib/labels/unit-context";
import UnitOperationalContextClient from "@/components/warehouse/UnitOperationalContextClient";
import UnitNotesClient from "@/components/warehouse/UnitNotesClient";

export default async function WarehouseUnitPage({ params }: { params: Promise<{ unitId: string }> }) {
  const session = await requireCapability("inventory.read");
  const principal = await getPrincipal();
  if (!principal) notFound();
  const { unitId } = await params;
  const unit = await getWarehouseUnit(principal, { unitId }).catch((error) => { if (error instanceof WarehouseCommandError && error.status === 404) notFound(); throw error; });
  const context = principal.capabilities.includes("workflow.read") ? await getUnitLabelContext(principal, { unitId }) : null;
  return <div className="min-h-screen bg-base-200"><NavBar session={session} /><main className="mx-auto max-w-4xl px-3 py-6 sm:px-6">{context && <UnitOperationalContextClient key={`${principal.siteId}:${unit.unitId}`} initial={context} canReadLabels={principal.capabilities.includes("labels.read")} canPrint={principal.capabilities.includes("labels.print")} canManageLabels={principal.capabilities.includes("labels.manage")} />}<UnitNotesClient key={`${principal.siteId}:${unit.unitId}:notes`} unitId={unit.unitId} userId={principal.userId} canWrite={principal.capabilities.includes("inventory.write")} canCorrectOthers={principal.capabilities.includes("office.decide")} /><WarehouseUnitClient key={`${principal.siteId}:${unit.unitId}`} initial={unit} canIdentify={principal.capabilities.includes("inventory.identify")} /></main></div>;
}
