import NavBar from "@/components/NavBar";
import MarsAuditClient from "@/components/mars/MarsAuditClient";
import MarsNav from "@/components/mars/MarsNav";
import { requireAuth } from "@/lib/auth";
import { listSubmittedMarsAuditSessions } from "@/lib/mars/audit";

export default async function MarsAuditPage() {
  const session = await requireAuth();
  const auditHistory = await listSubmittedMarsAuditSessions(20);

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-semibold text-base-content mb-1">MARS Audit</h1>
        <p className="text-base-content/70 mb-6">
          Capture scans from the Zebra, submit them into an amendable audit session, and generate
          saved reports only when the session is ready.
        </p>
        <MarsNav />
        <MarsAuditClient initialHistory={auditHistory} />
      </main>
    </div>
  );
}
