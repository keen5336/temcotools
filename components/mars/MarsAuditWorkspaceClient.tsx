"use client";

import { useMemo, useState, useTransition } from "react";
import type { MarsAuditDetail, MarsSavedAuditReport } from "@/lib/mars/audit";

interface MarsAuditWorkspaceClientProps {
  initialData: MarsAuditDetail;
}

export default function MarsAuditWorkspaceClient({
  initialData,
}: MarsAuditWorkspaceClientProps) {
  const [data, setData] = useState(initialData);
  const [scanValue, setScanValue] = useState("");
  const [reportLabel, setReportLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const latestSavedReport = data.savedReports[0] ?? null;
  const currentSummary = useMemo(() => data.currentReport.summary, [data.currentReport.summary]);

  function handleAddScan(manualEntry: boolean) {
    const normalized = scanValue.trim();
    if (!normalized) return;

    startTransition(async () => {
      setError(null);
      const response = await fetch(`/api/mars/audit/${encodeURIComponent(data.session.id)}/scans`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scannedValue: normalized, manualEntry }),
      });

      const payload = (await response.json()) as
        | {
            ok: true;
            id: string;
            scannedValue: string;
            matched: boolean;
            duplicateInSession: boolean;
            manualEntry: boolean;
            createdAt: string;
            unit: MarsAuditDetail["scans"][number]["unit"];
          }
        | { ok: false; error: string };

      if (!response.ok || !payload.ok) {
        setError("error" in payload ? payload.error : "Failed to add scan.");
        return;
      }

      setData((current) => ({
        ...current,
        session: {
          ...current.session,
          scanCount: current.session.scanCount + 1,
          summary: {
            totalScans: current.session.summary.totalScans + 1,
            matchedScans: current.session.summary.matchedScans + (payload.matched ? 1 : 0),
            duplicateScans:
              current.session.summary.duplicateScans + (payload.duplicateInSession ? 1 : 0),
            unknownScans: current.session.summary.unknownScans + (payload.matched ? 0 : 1),
          },
          lastAmendedAt: new Date(),
        },
        scans: [
          {
            id: payload.id,
            scannedValue: payload.scannedValue,
            matched: payload.matched,
            duplicateInSession: payload.duplicateInSession,
            manualEntry: payload.manualEntry,
            createdAt: new Date(payload.createdAt),
            unit: payload.unit,
          },
          ...current.scans,
        ],
      }));
      setScanValue("");
      window.location.reload();
    });
  }

  function handleDeleteScan(scanId: string) {
    startTransition(async () => {
      setError(null);
      const response = await fetch(
        `/api/mars/audit/${encodeURIComponent(data.session.id)}/scans/${encodeURIComponent(scanId)}`,
        { method: "DELETE" }
      );

      const payload = (await response.json()) as { ok: true } | { ok: false; error: string };
      if (!response.ok || !payload.ok) {
        setError("error" in payload ? payload.error : "Failed to remove scan.");
        return;
      }

      window.location.reload();
    });
  }

  function handleGenerateReport() {
    startTransition(async () => {
      setError(null);
      const response = await fetch(`/api/mars/audit/${encodeURIComponent(data.session.id)}/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: reportLabel }),
      });

      const payload = (await response.json()) as
        | {
            ok: true;
            reportId: string;
            label: string | null;
            createdAt: string;
            payload: MarsAuditDetail["currentReport"];
          }
        | { ok: false; error: string };

      if (!response.ok || !payload.ok) {
        setError("error" in payload ? payload.error : "Failed to generate report.");
        return;
      }

      const nextReport: MarsSavedAuditReport = {
        id: payload.reportId,
        label: payload.label,
        createdAt: payload.createdAt as unknown as Date,
        generatedBy: "Current user",
        importBatch: payload.payload.importBatch,
        summary: payload.payload.summary,
        payload: payload.payload,
      };

      setData((current) => ({
        ...current,
        currentReport: payload.payload,
        savedReports: [nextReport, ...current.savedReports],
      }));
      setReportLabel("");
    });
  }

  return (
    <div className="space-y-6">
      <section className="card bg-base-100 border border-base-200 shadow-sm">
        <div className="card-body gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="card-title">Audit Workspace</h2>
              <p className="text-sm text-base-content/70">
                This session stays editable. Add scans, remove mistakes, then generate reports when
                you want a saved snapshot of the discrepancies.
              </p>
            </div>
            <div className="text-sm text-base-content/70">
              Last amended {formatDate(data.session.lastAmendedAt ?? data.session.completedAt ?? data.session.startedAt)}
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <CountCard label="Expected Missing" value={currentSummary.expectedMissing} tone="error" />
            <CountCard label="Present Unexpected" value={currentSummary.physicallyPresentButUnexpected} tone="warning" />
            <CountCard label="Unknown Scans" value={currentSummary.unknownScans} tone="warning" />
            <CountCard label="Scanned Twice+" value={currentSummary.duplicates} tone="warning" />
            <CountCard label="Matched" value={currentSummary.matched} tone="success" />
          </div>

          <div className="flex flex-col lg:flex-row gap-3">
            <input
              type="text"
              value={scanValue}
              onChange={(event) => setScanValue(event.target.value)}
              placeholder="Scan or type a request number to amend this audit"
              className="input input-bordered input-lg flex-1"
              disabled={isPending}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={!scanValue.trim() || isPending}
              onClick={() => handleAddScan(false)}
            >
              Add Scan
            </button>
            <button
              type="button"
              className="btn btn-outline"
              disabled={!scanValue.trim() || isPending}
              onClick={() => handleAddScan(true)}
            >
              Add Manual
            </button>
          </div>

          <div className="flex flex-col lg:flex-row gap-3">
            <input
              type="text"
              value={reportLabel}
              onChange={(event) => setReportLabel(event.target.value)}
              placeholder="Optional report label"
              className="input input-bordered flex-1"
              disabled={isPending}
            />
            <button
              type="button"
              className="btn btn-secondary"
              disabled={isPending}
              onClick={handleGenerateReport}
            >
              Generate Saved Report
            </button>
          </div>

          {error ? (
            <div className="alert alert-error">
              <span>{error}</span>
            </div>
          ) : null}
        </div>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)] gap-6">
        <div className="card bg-base-100 border border-base-200 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-base-200">
            <h2 className="text-lg font-semibold text-base-content">Current Session Scans</h2>
            <p className="text-sm text-base-content/70 mt-1">
              Remove mistakes here instead of rerunning the whole audit.
            </p>
          </div>
          <div className="max-h-[520px] overflow-auto">
            <table className="table table-zebra">
              <thead>
                <tr>
                  <th>Scanned Value</th>
                  <th>Status</th>
                  <th>Type</th>
                  <th>Added</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.scans.length ? (
                  data.scans.map((scan) => (
                    <tr key={scan.id}>
                      <td className="font-medium">{scan.scannedValue}</td>
                      <td>
                        {scan.duplicateInSession
                          ? "Duplicate"
                          : scan.matched
                            ? "Matched"
                            : "Unknown"}
                      </td>
                      <td>{scan.manualEntry ? "Manual" : "Scanner"}</td>
                      <td>{formatDate(scan.createdAt)}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-xs btn-ghost text-error"
                          disabled={isPending}
                          onClick={() => handleDeleteScan(scan.id)}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="text-center text-base-content/60 py-8">
                      No scans are saved in this session yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-6">
          <section className="card bg-base-100 border border-base-200 shadow-sm">
            <div className="card-body">
              <h2 className="card-title">Saved Reports</h2>
              {data.savedReports.length ? (
                <div className="space-y-3">
                  {data.savedReports.map((report) => (
                    <div key={report.id} className="rounded-xl border border-base-200 p-4">
                      <p className="font-semibold">{report.label || report.id.slice(0, 8)}</p>
                      <p className="text-sm text-base-content/70">
                        Generated {formatDate(report.createdAt)} by {report.generatedBy ?? "Unknown"}
                      </p>
                      <p className="text-sm text-base-content/70 mt-2">
                        Missing {report.summary.expectedMissing} | Unexpected {report.summary.physicallyPresentButUnexpected} | Unknown {report.summary.unknownScans}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-base-content/60">
                  No saved reports yet. Generate one when you want to preserve this audit state.
                </p>
              )}
            </div>
          </section>

          <section className="card bg-base-100 border border-base-200 shadow-sm">
            <div className="card-body">
              <h2 className="card-title">Latest Report Snapshot</h2>
              <p className="text-sm text-base-content/70">
                {latestSavedReport
                  ? `Most recent saved report: ${latestSavedReport.label || latestSavedReport.id.slice(0, 8)}`
                  : "Showing the live report computed from the current session contents."}
              </p>

              <div className="mt-3 space-y-3 text-sm">
                <ReportList title="Expected Missing" rows={data.currentReport.expectedMissing.map((row) => row.requestNumber)} />
                <ReportList
                  title="Present Unexpected"
                  rows={data.currentReport.physicallyPresentButUnexpected.map((row) => row.requestNumber)}
                />
                <ReportList title="Unknown Scans" rows={data.currentReport.unknownScans.map((row) => row.scannedValue)} />
              </div>
            </div>
          </section>
        </div>
      </section>
    </div>
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

function ReportList({ title, rows }: { title: string; rows: string[] }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-base-content/60">{title}</p>
      {rows.length ? (
        <div className="mt-1 text-base-content">{rows.slice(0, 6).join(", ")}</div>
      ) : (
        <div className="mt-1 text-base-content/60">None</div>
      )}
    </div>
  );
}

function formatDate(value: string | Date | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}
