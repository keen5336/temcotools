import NavBar from "@/components/NavBar";
import ApiRelayManagerClient from "@/components/api-relay/ApiRelayManagerClient";
import { requireAdmin } from "@/lib/auth";
import { currentRelayAdmin } from "@/lib/api-relay/definitions";

export default async function ApiRelayManagerPage() {
  const session = await requireAdmin();
  await currentRelayAdmin(session.userId);
  return <div className="min-h-screen bg-base-200"><NavBar session={session} /><main className="max-w-6xl mx-auto px-4 py-8 space-y-6"><div><h1 className="text-2xl font-semibold">API Relay Management</h1><p className="mt-2 text-base-content/65">Define the external systems, URL rules, named operations and code used by Connect Temco. Only administrators can change these definitions.</p></div><ApiRelayManagerClient /></main></div>;
}
