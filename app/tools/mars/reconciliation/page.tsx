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
      <main className="max-w-[1600px] mx-auto px-4 py-8">
        <h1 className="text-2xl font-semibold text-base-content mb-1">MARS Reconciliation</h1>
        <p className="text-base-content/70 mb-6">
          Comparison of the latest imported MARS snapshot against the latest completed audit,
          focused on what should be here and what should not be here.
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

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
          <CountCard label="Expected Missing" value={data.summary.expectedMissing} tone="error" />
          <CountCard
            label="Present Unexpected"
            value={data.summary.physicallyPresentButUnexpected}
            tone="warning"
          />
          <CountCard label="Staged" value={data.summary.staged} tone="info" />
          <CountCard label="Unknown Scans" value={data.summary.unknownScans} tone="warning" />
          <CountCard label="Matched" value={data.summary.matched} tone="success" />
        </div>

        <div className="space-y-6">
          <CollapsibleSection
            title="Expected Missing"
            subtitle={`${data.expectedMissing.length} items expected to be here but not seen`}
          >
            <UnitSection rows={data.expectedMissing} emptyMessage="No expected-missing items." />
          </CollapsibleSection>

          <CollapsibleSection
            title="Physically Present but Unexpected"
            subtitle={`${data.physicallyPresentButUnexpected.length} items seen that should not still be here or were not in the import`}
          >
            <UnitSection
              rows={data.physicallyPresentButUnexpected}
              emptyMessage="No unexpected-present items."
            />
          </CollapsibleSection>

          <CollapsibleSection
            title="Unknown Scans"
            subtitle={`${data.unknownScans.length} scanned values that were not found in the imported master list`}
          >
            <UnknownScanSection rows={data.unknownScans} />
          </CollapsibleSection>

          <CollapsibleSection
            title="Staged"
            subtitle={`${data.staged.length} locally staged items`}
            defaultOpen={false}
          >
            <UnitSection rows={data.staged} emptyMessage="No staged items." />
          </CollapsibleSection>

          <CollapsibleSection
            title="Matched"
            subtitle={`${data.matched.length} expected items that were confirmed in the latest audit`}
            defaultOpen={false}
          >
            <UnitSection rows={data.matched} emptyMessage="No matched items." />
          </CollapsibleSection>
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

function CollapsibleSection({
  title,
  subtitle,
  children,
  defaultOpen = true,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details
      className="rounded-2xl border border-base-200 bg-base-100 shadow-sm overflow-hidden"
      open={defaultOpen}
    >
      <summary className="cursor-pointer list-none px-5 py-4 border-b border-base-200 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-base-content">{title}</h2>
          <p className="text-sm text-base-content/70 mt-1">{subtitle}</p>
        </div>
        <span className="text-sm text-base-content/50">Show / Hide</span>
      </summary>
      <div>{children}</div>
    </details>
  );
}

function UnitSection({
  rows,
  emptyMessage,
}: {
  title?: string;
  rows: Array<{
    requestNumber: string;
    orderNumber: string | null;
    vendor: string | null;
    serialNumber: string | null;
    modelNumber: string | null;
    dateRequested: Date | null;
    returnStatus: string | null;
    staged: boolean;
    reason: string;
  }>;
  emptyMessage: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="table table-zebra">
        <thead>
          <tr>
            <th>Request #</th>
            <th>H# / Order</th>
            <th>Date Requested</th>
            <th>Vendor</th>
            <th>Serial</th>
            <th>MS# / Model</th>
            <th>Return Status</th>
            <th>Staged</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((row) => (
              <tr key={`${row.requestNumber}-${row.reason}`}>
                <td className="font-medium">{row.requestNumber}</td>
                <td>{row.orderNumber ?? "—"}</td>
                <td>{formatDateOnly(row.dateRequested)}</td>
                <td>{row.vendor ?? "—"}</td>
                <td>{row.serialNumber ?? "—"}</td>
                <td>{row.modelNumber ?? "—"}</td>
                <td>{row.returnStatus ?? "—"}</td>
                <td>
                  <span className={`badge ${row.staged ? "badge-info" : "badge-ghost"}`}>
                    {row.staged ? "Staged" : "No"}
                  </span>
                </td>
                <td className="max-w-md whitespace-normal">{row.reason}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={9} className="text-center text-base-content/60 py-8">
                {emptyMessage}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
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
    <div className="overflow-x-auto">
      <table className="table table-zebra">
        <thead>
          <tr>
            <th>Scanned Value</th>
            <th>Scanned At</th>
            <th>Audit</th>
            <th>Scanned Twice+</th>
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
  );
}

function formatDateOnly(value: string | Date | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString();
}
