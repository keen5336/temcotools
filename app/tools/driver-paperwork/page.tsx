import NavBar from "@/components/NavBar";
import DriverPaperworkClient from "@/components/driver-paperwork/DriverPaperworkClient";
import { requireAuth } from "@/lib/auth";

export default async function DriverPaperworkPage() {
  const session = await requireAuth();
  return <div className="min-h-screen bg-base-200">
    <NavBar session={session} />
    <main className="max-w-3xl mx-auto px-4 py-8"><DriverPaperworkClient /></main>
  </div>;
}
