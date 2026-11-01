import { requireCapability } from "@/lib/auth";
import NavBar from "@/components/NavBar";
import AccessGrantsClient from "@/components/access/AccessGrantsClient";
export default async function AccessPage() {
  const session = await requireCapability("account.self");
  return <div className="min-h-screen bg-base-200"><NavBar session={session} /><main className="max-w-3xl mx-auto p-4"><h1 className="text-2xl font-bold mb-4">Your connected clients</h1><AccessGrantsClient /></main></div>;
}
