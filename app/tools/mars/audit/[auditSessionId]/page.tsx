import Link from "next/link";
import { notFound } from "next/navigation";
import NavBar from "@/components/NavBar";
import MarsNav from "@/components/mars/MarsNav";
import MarsAuditWorkspaceClient from "@/components/mars/MarsAuditWorkspaceClient";
import { requireAuth } from "@/lib/auth";
import { getMarsAuditDetail } from "@/lib/mars/audit";

export default async function MarsAuditDetailPage({
  params,
}: {
  params: Promise<{ auditSessionId: string }>;
}) {
  const session = await requireAuth();
  const { auditSessionId } = await params;
  const data = await getMarsAuditDetail(auditSessionId);

  if (!data) {
    notFound();
  }

  const audit = data;

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-[1600px] mx-auto px-4 py-8">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-base-content mb-1">
              Audit Session {audit.session.id.slice(0, 8)}
            </h1>
            <p className="text-base-content/70">
              Captured {formatDate(audit.session.startedAt)} with {audit.session.scanCount} saved
              scans. Reports are generated separately and kept as history.
            </p>
          </div>
          <Link href="/tools/mars/audit" className="btn btn-outline">
            Back to Audit
          </Link>
        </div>

        <MarsNav />

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <SummaryPanel
            title="Audit Session"
            primary={audit.session.id.slice(0, 8)}
            secondary={`Started ${formatDate(audit.session.startedAt)} by ${audit.session.startedBy ?? "Unknown"}`}
          />
          <SummaryPanel
            title="Current Snapshot"
            primary={audit.currentReport.importBatch?.filename ?? "No import snapshot linked"}
            secondary={
              audit.currentReport.importBatch
                ? `Uploaded ${formatDate(audit.currentReport.importBatch.uploadedAt)}`
                : "This session does not have an import snapshot to compare against."
            }
          />
          <SummaryPanel
            title="Saved Reports"
            primary={String(audit.savedReports.length)}
            secondary="Generate a new report any time after amending the session."
          />
        </div>

        <MarsAuditWorkspaceClient initialData={audit} />
      </main>
    </div>
  );
}

function SummaryPanel({
  title,
  primary,
  secondary,
}: {
  title: string;
  primary: string;
  secondary: string;
}) {
  return (
    <section className="rounded-2xl border border-base-200 bg-base-100 p-5 shadow-sm">
      <p className="text-xs uppercase tracking-[0.2em] text-base-content/60 mb-2">{title}</p>
      <p className="text-lg font-semibold text-base-content">{primary}</p>
      <p className="text-sm text-base-content/70 mt-1">{secondary}</p>
    </section>
  );
}

function formatDate(value: string | Date | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}
