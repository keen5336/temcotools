import Link from "next/link";
import { notFound } from "next/navigation";
import NavBar from "@/components/NavBar";
import MarsNav from "@/components/mars/MarsNav";
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

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-[1600px] mx-auto px-4 py-8">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-base-content mb-1">
              Audit {data.session.id.slice(0, 8)}
            </h1>
            <p className="text-base-content/70">
              Completed {formatDate(data.session.completedAt)} with {data.session.scanCount} scans.
            </p>
          </div>
          <Link href="/tools/mars/audit" className="btn btn-outline">
            Back to Audit
          </Link>
        </div>

        <MarsNav />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
          <SummaryPanel
            title="Audit Session"
            primary={data.session.id.slice(0, 8)}
            secondary={`Started ${formatDate(data.session.startedAt)} by ${data.session.startedBy ?? "Unknown"}`}
          />
          <SummaryPanel
            title="Import Snapshot"
            primary={data.report.importBatch?.filename ?? "No snapshot linked"}
            secondary={
              data.report.importBatch
                ? `Uploaded ${formatDate(data.report.importBatch.uploadedAt)}`
                : "This audit did not capture an import snapshot."
            }
          />
          <SummaryPanel
            title="Duplicate Meaning"
            primary={`${data.report.summary.duplicates} scanned twice+`}
            secondary="A duplicate means the same Request Number was captured more than once inside this audit."
          />
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
          <CountCard label="Expected Missing" value={data.report.summary.expectedMissing} tone="error" />
          <CountCard
            label="Present Unexpected"
            value={data.report.summary.physicallyPresentButUnexpected}
            tone="warning"
          />
          <CountCard label="Unknown Scans" value={data.report.summary.unknownScans} tone="warning" />
          <CountCard label="Scanned Twice+" value={data.report.summary.duplicates} tone="warning" />
          <CountCard label="Matched" value={data.report.summary.matched} tone="success" />
        </div>

        <div className="space-y-6">
          <CollapsibleSection
            title="Expected Missing"
            subtitle={`${data.report.expectedMissing.length} items expected to be here but not scanned`}
          >
            <UnitSection rows={data.report.expectedMissing} emptyMessage="No expected-missing items." />
          </CollapsibleSection>

          <CollapsibleSection
            title="Physically Present but Unexpected"
            subtitle={`${data.report.physicallyPresentButUnexpected.length} items scanned that should not still be here or were not in the import`}
          >
            <UnitSection
              rows={data.report.physicallyPresentButUnexpected}
              emptyMessage="No unexpected-present items."
            />
          </CollapsibleSection>

          <CollapsibleSection
            title="Unknown Scans"
            subtitle={`${data.report.unknownScans.length} scanned values that were not found in the imported master list`}
          >
            <UnknownScanSection rows={data.report.unknownScans} emptyMessage="No unknown scans." />
          </CollapsibleSection>

          <CollapsibleSection
            title="Scanned More Than Once"
            subtitle={`${data.report.duplicates.length} scans where the same Request Number was captured more than once in this audit`}
            defaultOpen={false}
          >
            <UnknownScanSection
              rows={data.report.duplicates}
              emptyMessage="No duplicated scans in this audit."
            />
          </CollapsibleSection>

          <CollapsibleSection
            title="Matched"
            subtitle={`${data.report.matched.length} expected items that were confirmed present`}
            defaultOpen={false}
          >
            <UnitSection rows={data.report.matched} emptyMessage="No matched items." />
          </CollapsibleSection>

          <CollapsibleSection
            title="Submitted Scans"
            subtitle={`${data.scans.length} raw submitted scans in newest-first order`}
            defaultOpen={false}
          >
            <SubmittedScanSection rows={data.scans} />
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
  tone: "success" | "warning" | "error";
}) {
  const tones = {
    success: "border-success/30 bg-success/10",
    warning: "border-warning/30 bg-warning/10",
    error: "border-error/30 bg-error/10",
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
  emptyMessage,
}: {
  rows: Array<{
    scanId: string;
    scannedValue: string;
    createdAt: Date;
    duplicateInSession: boolean;
  }>;
  emptyMessage: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="table table-zebra">
        <thead>
          <tr>
            <th>Scanned Value</th>
            <th>Scanned At</th>
            <th>Scanned Twice+</th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((row) => (
              <tr key={row.scanId}>
                <td className="font-medium">{row.scannedValue}</td>
                <td>{formatDate(row.createdAt)}</td>
                <td>{row.duplicateInSession ? "Yes" : "No"}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={3} className="text-center text-base-content/60 py-8">
                {emptyMessage}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function SubmittedScanSection({
  rows,
}: {
  rows: Array<{
    id: string;
    scannedValue: string;
    matched: boolean;
    duplicateInSession: boolean;
    createdAt: Date;
    unit: {
      requestNumber: string;
      orderNumber: string | null;
      vendor: string | null;
      serialNumber: string | null;
      modelNumber: string | null;
      dateRequested: Date | null;
      returnStatus: string | null;
      staged: boolean;
    } | null;
  }>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="table table-zebra">
        <thead>
          <tr>
            <th>Scanned Value</th>
            <th>Time</th>
            <th>Status</th>
            <th>Request #</th>
            <th>H# / Order</th>
            <th>Date Requested</th>
            <th>Vendor</th>
            <th>Serial</th>
            <th>MS# / Model</th>
            <th>Return Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((row) => (
              <tr key={row.id}>
                <td className="font-medium">{row.scannedValue}</td>
                <td>{formatDate(row.createdAt)}</td>
                <td>
                  {row.duplicateInSession
                    ? "Scanned twice+"
                    : row.matched
                      ? row.unit?.staged
                        ? "Matched + Staged"
                        : "Matched"
                      : "Unknown"}
                </td>
                <td>{row.unit?.requestNumber ?? "—"}</td>
                <td>{row.unit?.orderNumber ?? "—"}</td>
                <td>{formatDateOnly(row.unit?.dateRequested ?? null)}</td>
                <td>{row.unit?.vendor ?? "—"}</td>
                <td>{row.unit?.serialNumber ?? "—"}</td>
                <td>{row.unit?.modelNumber ?? "—"}</td>
                <td>{row.unit?.returnStatus ?? "—"}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={10} className="text-center text-base-content/60 py-8">
                No submitted scans.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function formatDate(value: string | Date | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function formatDateOnly(value: string | Date | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString();
}
