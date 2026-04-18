import Link from "next/link";
import NavBar from "@/components/NavBar";
import MarsNav from "@/components/mars/MarsNav";
import { requireAuth } from "@/lib/auth";
import { getMarsAuditDetail } from "@/lib/mars/audit";
import { notFound } from "next/navigation";

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
      <main className="max-w-[1500px] mx-auto px-4 py-8">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-base-content mb-1">Audit {data.session.id.slice(0, 8)}</h1>
            <p className="text-base-content/70">
              Completed {formatDate(data.session.completedAt)} with {data.session.scanCount} scans.
            </p>
          </div>
          <Link href="/tools/mars/audit" className="btn btn-outline">
            Back to Audit
          </Link>
        </div>

        <MarsNav />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
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
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
          <CountCard label="Expected Missing" value={data.report.summary.expectedMissing} tone="error" />
          <CountCard
            label="Present Unexpected"
            value={data.report.summary.physicallyPresentButUnexpected}
            tone="warning"
          />
          <CountCard label="Unknown Scans" value={data.report.summary.unknownScans} tone="warning" />
          <CountCard label="Duplicates" value={data.report.summary.duplicates} tone="warning" />
          <CountCard label="Matched" value={data.report.summary.matched} tone="success" />
        </div>

        <div className="space-y-6">
          <UnitSection title="Expected Missing" rows={data.report.expectedMissing} />
          <UnitSection
            title="Physically Present but Unexpected"
            rows={data.report.physicallyPresentButUnexpected}
          />
          <UnknownScanSection title="Unknown Scans" rows={data.report.unknownScans} />
          <UnknownScanSection title="Duplicate Scans" rows={data.report.duplicates} />
          <UnitSection title="Matched" rows={data.report.matched} />
          <SubmittedScanSection rows={data.scans} />
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
                  <td>{formatDate(row.lastAuditSeenAt)}</td>
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
  title,
  rows,
}: {
  title: string;
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
        <h2 className="text-lg font-semibold text-base-content">{title}</h2>
        <p className="text-sm text-base-content/70 mt-1">{rows.length} scans</p>
      </div>
      <div className="overflow-x-auto">
        <table className="table table-zebra">
          <thead>
            <tr>
              <th>Scanned Value</th>
              <th>Scanned At</th>
              <th>Duplicate</th>
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
                  No scans in this bucket.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
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
      vendor: string | null;
      serialNumber: string | null;
      modelNumber: string | null;
      requestStatus: string | null;
      returnStatus: string | null;
      staged: boolean;
    } | null;
  }>;
}) {
  return (
    <section className="rounded-2xl border border-base-200 bg-base-100 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-base-200">
        <h2 className="text-lg font-semibold text-base-content">Submitted Scans</h2>
        <p className="text-sm text-base-content/70 mt-1">{rows.length} scans</p>
      </div>
      <div className="overflow-x-auto">
        <table className="table table-zebra">
          <thead>
            <tr>
              <th>Scanned Value</th>
              <th>Time</th>
              <th>Status</th>
              <th>Request</th>
              <th>Vendor</th>
              <th>Serial</th>
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
                      ? "Duplicate"
                      : row.matched
                        ? row.unit?.staged
                          ? "Matched + Staged"
                          : "Matched"
                        : "Unknown"}
                  </td>
                  <td>{row.unit?.requestNumber ?? "—"}</td>
                  <td>{row.unit?.vendor ?? "—"}</td>
                  <td>{row.unit?.serialNumber ?? "—"}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="text-center text-base-content/60 py-8">
                  No submitted scans.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function formatDate(value: string | Date | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}
