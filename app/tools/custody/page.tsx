import NavBar from "@/components/NavBar";
import { getPrincipal, requireCapability } from "@/lib/auth";
import { notFound } from "next/navigation";
import { pilotPolicy } from "../../../scripts/pilot-policy.mjs";
import CustodyClient from "./CustodyClient";

export default async function CustodyPage() {
  const session = await requireCapability("inventory.read"), principal = await getPrincipal();
  if (!principal?.siteId) notFound();
  return <div className="min-h-screen bg-base-200"><NavBar session={session}/><main className="mx-auto max-w-4xl px-3 py-6 sm:px-6"><CustodyClient key={principal.siteId} siteId={principal.siteId} siteName={principal.siteName ?? "Current warehouse"} canManage={principal.capabilities.includes("inventory.custody")} physicalEnabled={!pilotPolicy().isolated}/></main></div>;
}
