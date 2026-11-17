import NavBar from "@/components/NavBar";
import RelayConfigurationClient from "@/components/relays/RelayConfigurationClient";
import LabelConfigurationClient from "@/components/labels/LabelConfigurationClient";
import { requireAuth } from "@/lib/auth";

export default async function ConfigurationPage() {
  const session = await requireAuth();
  return <div className="min-h-screen bg-base-200"><NavBar session={session} /><main className="max-w-6xl mx-auto px-4 py-8 space-y-6">
    <div><h1 className="text-2xl font-semibold">Configuration</h1><p className="mt-2 text-base-content/65">Connect external systems and configure label delivery.</p></div>
    <RelayConfigurationClient admin={session.role === "admin"} />
    {(session.role === "manager" || session.role === "admin") && <section id="labels" className="space-y-4 scroll-mt-6"><div><h2 className="text-xl font-semibold">Shared label configuration</h2><p className="text-sm text-base-content/65 mt-1">Manage printer destinations and workflow templates available to all operators.</p></div><LabelConfigurationClient /></section>}
  </main></div>;
}
