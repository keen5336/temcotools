import { getCurrentPrincipal, requireAuth } from "@/lib/auth";
import NavBar from "@/components/NavBar";
import ToolDashboard from "@/components/tools/ToolDashboard";
import OperationalDashboard from "@/components/tools/OperationalDashboard";
import { getOperationalDashboard } from "@/lib/dashboard";

export default async function HomePage() {
  const session = await requireAuth();
  const principal = await getCurrentPrincipal();
  const dashboard = principal ? await getOperationalDashboard(principal).catch(() => null) : null;
  return <div className="min-h-screen bg-base-200"><NavBar session={session} /><main className="max-w-5xl mx-auto px-4 py-6 space-y-10"><OperationalDashboard initial={dashboard} /><ToolDashboard /></main></div>;
}
