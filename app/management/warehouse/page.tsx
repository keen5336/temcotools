import { requireCapability } from "@/lib/auth";
import WarehouseSettingsClient from "./WarehouseSettingsClient";
export default async function WarehouseSettingsPage() {
  await requireCapability("sites.configure");
  return <main className="max-w-3xl mx-auto p-4"><WarehouseSettingsClient /></main>;
}
