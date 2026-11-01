import NavBar from "@/components/NavBar";
import MarsAuditClient from "@/components/mars/MarsAuditClient";
import MarsNav from "@/components/mars/MarsNav";
import { requireMarsPage } from "@/lib/mars/page";
import { getMarsAudits } from "@/lib/mars/service";

export default async function MarsAuditPage() {
  const { session, principal } = await requireMarsPage();
  const auditHistory = await getMarsAudits(principal, { limit: 20 });

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
        <MarsAuditClient initialHistory={auditHistory} currentUserId={session.userId!} currentSessionId={session.sessionId!} />
      </main>
    </div>
  );
}
