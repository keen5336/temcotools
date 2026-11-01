import { requireAdmin } from "@/lib/auth";
import NavBar from "@/components/NavBar";
import PayloadManagerClient from "@/components/payloads/PayloadManagerClient";
export default async function PayloadManagerPage() {
  const session = await requireAdmin();
  return <div className="min-h-screen bg-base-200"><NavBar session={session} /><main className="max-w-6xl mx-auto p-4 sm:p-6"><PayloadManagerClient /></main></div>;
}
