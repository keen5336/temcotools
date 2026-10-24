import NavBar from "@/components/NavBar";
import ApiRelayClient from "@/components/api-relay/ApiRelayClient";
import { requireAuth } from "@/lib/auth";

export default async function ApiRelayPage() {
  const session = await requireAuth();
  return <div className="min-h-screen bg-base-200"><NavBar session={session} /><main className="max-w-5xl mx-auto px-4 py-8"><ApiRelayClient /></main></div>;
}
