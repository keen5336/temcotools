import { requireAuth } from "@/lib/auth";
import NavBar from "@/components/NavBar";
import ToolDashboard from "@/components/tools/ToolDashboard";

export default async function HomePage() {
  const session = await requireAuth();
  return <div className="min-h-screen bg-base-200"><NavBar session={session} /><main className="max-w-5xl mx-auto px-4 py-10"><ToolDashboard /></main></div>;
}
