import Link from "next/link";
import { getCurrentPrincipal, requireAuth } from "@/lib/auth";
import NavBar from "@/components/NavBar";
import ToolDashboard from "@/components/tools/ToolDashboard";
import OperationalDashboard from "@/components/tools/OperationalDashboard";
import { getOperationalDashboard } from "@/lib/dashboard";

export default async function HomePage() {
  const session = await requireAuth();
  const principal = await getCurrentPrincipal();
  const dashboard = principal ? await getOperationalDashboard(principal).catch(() => null) : null;
  return <div className="min-h-screen bg-base-200"><NavBar session={session} /><main className="max-w-5xl mx-auto px-4 py-6 space-y-10">{principal?.capabilities.includes("workflow.read") && <section className="rounded-xl bg-base-100 p-5 space-y-3"><h1 className="text-xl font-bold">Warehouse workflows</h1><p>Start or resume a workflow. Receiving practice is local and makes no WMS or print changes.</p><div className="flex flex-wrap gap-3"><Link className="btn btn-primary" href="/tools/workflows">Open workflows</Link><Link className="btn btn-outline" href="/management/connections">Connections &amp; readiness</Link></div></section>}<OperationalDashboard initial={dashboard} /><ToolDashboard /></main></div>;
}
