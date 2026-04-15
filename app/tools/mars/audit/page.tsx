import NavBar from "@/components/NavBar";
import MarsAuditClient from "@/components/mars/MarsAuditClient";
import MarsNav from "@/components/mars/MarsNav";
import { requireAuth } from "@/lib/auth";

export default async function MarsAuditPage() {
  const session = await requireAuth();

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-semibold text-base-content mb-1">MARS Audit</h1>
        <p className="text-base-content/70 mb-6">
          Scanner-first warehouse audit flow for request-number barcodes, duplicate detection, and
          immediate physical verification timestamps.
        </p>
        <MarsNav />
        <MarsAuditClient />
      </main>
    </div>
  );
}
