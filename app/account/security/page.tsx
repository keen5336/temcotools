import { requireAuth } from "@/lib/auth";
import NavBar from "@/components/NavBar";
import AccountSecurityClient from "@/components/account/AccountSecurityClient";

export default async function AccountSecurityPage() {
  const session = await requireAuth();
  return <div className="min-h-screen bg-base-200"><NavBar session={session} /><main className="max-w-3xl mx-auto px-4 py-8 space-y-6"><h1 className="text-2xl font-semibold">Account security</h1><AccountSecurityClient /></main></div>;
}
