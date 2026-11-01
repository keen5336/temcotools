import { requireCapability } from "@/lib/auth";
import NavBar from "@/components/NavBar";
import WarehouseScanClient from "@/components/scanner/WarehouseScanClient";
export default async function WarehouseScanPage() {
  const session = await requireCapability("inventory.write");
  return <div className="min-h-screen bg-base-200"><NavBar session={session} /><main className="max-w-3xl mx-auto p-4"><WarehouseScanClient key={session.userId} userId={session.userId} displayName={session.displayName} /></main></div>;
}
