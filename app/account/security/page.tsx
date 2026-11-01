import { requireAuth } from "@/lib/auth";
import NavBar from "@/components/NavBar";
import SecurityClient from "./SecurityClient";

export default async function AccountSecurityPage() {
  const session = await requireAuth();
  return <div className="min-h-screen bg-base-200"><NavBar session={session} /><main className="max-w-3xl mx-auto p-4 space-y-4"><h1 className="text-2xl font-bold">Account security</h1><p>Signed in as {session.displayName}. Lock or switch a shared scanner before handing it to another person.</p><SecurityClient /></main></div>;
}
