import NavBar from "@/components/NavBar";
import MarsNav from "@/components/mars/MarsNav";
import { requireAuth } from "@/lib/auth";
import { getMarsReconciliation } from "@/lib/mars/reconciliation";

export default async function MarsReconciliationPage() {
  const session = await requireAuth();
  const data = await getMarsReconciliation();

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-[1500px] mx-auto px-4 py-8">
        <h1 className="text-2xl font-semibold text-base-content mb-1">MARS Reconciliation</h1>
        <p className="text-base-content/70 mb-6">
          Strict-mode comparison of the latest imported MARS snapshot, current local state, and
          the latest completed audit evidence.
        </p>
        <MarsNav />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          <SummaryPanel
            title="Latest Import"
            primary={data.latestImportBatch?.filename ?? "No imports yet"}
            secondary={
              data.latestImportBatch
                ? `Uploaded ${new Date(data.latestImportBatch.uploadedAt).toLocaleString()}`
                : "Import a spreadsheet to establish the current MARS authority snapshot."
            }
          />
          <SummaryPanel
            title="Latest Completed Audit"
            primary={
              data.latestCompletedAudit
                ? data.latestCompletedAudit.id.slice(0, 8)
                : "No completed audit"
            }
            secondary={
              data.latestCompletedAudit?.completedAt
                ? `Completed ${new Date(data.latestCompletedAudit.completedAt).toLocaleString()}`
                : "Complete an audit session to compare physical presence against MARS."
            }
          />
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-8">
          <CountCard label="Expected Missing" value={data.summary.expectedMissing} tone="error" />
          <CountCard
            label="Present Unexpected"
            value={data.summary.physicallyPresentButUnexpected}
            tone="warning"
          />
          <CountCard label="Staged" value={data.summary.staged} tone="info" />
          <CountCard label="Unknown Scans" value={data.summary.unknownScans} tone="warning" />
          <CountCard label="Stale Units" value={data.summary.staleUnits} tone="warning" />
          <CountCard label="Matched" value={data.summary.matched} tone="success" />
        </div>

        <div className="space-y-6">
          <UnitSection title="Expected Missing" rows={data.expectedMissing} />
          <UnitSection
            title="Physically Present but Unexpected"
            rows={data.physicallyPresentButUnexpected}
          />
          <UnitSection title="Staged" rows={data.staged} />
          <UnknownScanSection rows={data.unknownScans} />
          <UnitSection title="Stale Units" rows={data.staleUnits} />
          <UnitSection title="Matched" rows={data.matched} />
        </div>
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

function CountCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "success" | "warning" | "error" | "info";
}) {
  const tones = {
    success: "border-success/30 bg-success/10",
    warning: "border-warning/30 bg-warning/10",
    error: "border-error/30 bg-error/10",
    info: "border-info/30 bg-info/10",
  };

  return (
    <div className={`rounded-2xl border p-4 ${tones[tone]}`}>
      <p className="text-xs uppercase tracking-wide text-base-content/60">{label}</p>
      <p className="text-3xl font-semibold text-base-content">{value}</p>
    </div>
  );
}

function UnitSection({
  title,
  rows,
}: {
  title: string;
  rows: Array<{
    requestNumber: string;
    vendor: string | null;
    serialNumber: string | null;
    requestStatus: string | null;
    returnStatus: string | null;
    staged: boolean;
    lastAuditSeenAt: Date | null;
    reason: string;
  }>;
}) {
  return (
    <section className="rounded-2xl border border-base-200 bg-base-100 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-base-200">
        <h2 className="text-lg font-semibold text-base-content">{title}</h2>
        <p className="text-sm text-base-content/70 mt-1">{rows.length} units</p>
      </div>
      <div className="overflow-x-auto">
        <table className="table table-zebra">
          <thead>
            <tr>
              <th>Request</th>
              <th>Vendor</th>
              <th>Serial</th>
              <th>Request Status</th>
              <th>Return Status</th>
              <th>Staged</th>
              <th>Last Audit Seen</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((row) => (
                <tr key={`${title}-${row.requestNumber}`}>
                  <td className="font-medium">{row.requestNumber}</td>
                  <td>{row.vendor ?? "—"}</td>
                  <td>{row.serialNumber ?? "—"}</td>
                  <td>{row.requestStatus ?? "—"}</td>
                  <td>{row.returnStatus ?? "—"}</td>
                  <td>
                    <span className={`badge ${row.staged ? "badge-info" : "badge-ghost"}`}>
                      {row.staged ? "Staged" : "No"}
                    </span>
                  </td>
                  <td>{row.lastAuditSeenAt ? new Date(row.lastAuditSeenAt).toLocaleString() : "—"}</td>
                  <td className="max-w-md whitespace-normal">{row.reason}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={8} className="text-center text-base-content/60 py-8">
                  No units in this bucket.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function UnknownScanSection({
  rows,
}: {
  rows: Array<{
    scanId: string;
    scannedValue: string;
    createdAt: Date;
    auditSessionId: string;
    duplicateInSession: boolean;
  }>;
}) {
  return (
    <section className="rounded-2xl border border-base-200 bg-base-100 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-base-200">
        <h2 className="text-lg font-semibold text-base-content">Unknown Scans</h2>
        <p className="text-sm text-base-content/70 mt-1">{rows.length} scans</p>
      </div>
      <div className="overflow-x-auto">
        <table className="table table-zebra">
          <thead>
            <tr>
              <th>Scanned Value</th>
              <th>Scanned At</th>
              <th>Audit Session</th>
              <th>Duplicate</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((row) => (
                <tr key={row.scanId}>
                  <td className="font-medium">{row.scannedValue}</td>
                  <td>{new Date(row.createdAt).toLocaleString()}</td>
                  <td>{row.auditSessionId.slice(0, 8)}</td>
                  <td>{row.duplicateInSession ? "Yes" : "No"}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} className="text-center text-base-content/60 py-8">
                  No unknown scans in the latest completed audit.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
