"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { MarsAuditSummary, MarsAuditScanResult } from "@/lib/mars/audit";

interface ActiveAuditSession {
  id: string;
  startedAt: string;
}

interface CompletedAuditSession {
  id: string;
  completedAt: string;
}

const EMPTY_SUMMARY: MarsAuditSummary = {
  totalScans: 0,
  matchedScans: 0,
  duplicateScans: 0,
  unknownScans: 0,
};

export default function MarsAuditClient() {
  const [auditSession, setAuditSession] = useState<ActiveAuditSession | null>(null);
  const [summary, setSummary] = useState<MarsAuditSummary>(EMPTY_SUMMARY);
  const [scanValue, setScanValue] = useState("");
  const [lastResult, setLastResult] = useState<MarsAuditScanResult | null>(null);
  const [completedSession, setCompletedSession] = useState<CompletedAuditSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (auditSession) {
      inputRef.current?.focus();
    }
  }, [auditSession, lastResult]);

  function handleStartAudit() {
    startTransition(async () => {
      setError(null);
      setCompletedSession(null);
      setLastResult(null);
      setSummary(EMPTY_SUMMARY);

      const response = await fetch("/api/mars/audit/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const payload = (await response.json()) as
        | { ok: true; auditSession: ActiveAuditSession }
        | { ok: false; error: string };

      if (!response.ok || !payload.ok) {
        setError("error" in payload ? payload.error : "Failed to start audit session.");
        return;
      }

      setAuditSession(payload.auditSession);
      setScanValue("");
    });
  }

  function handleSubmitScan(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auditSession || !scanValue.trim()) {
      return;
    }

    const currentValue = scanValue;
    setScanValue("");

    startTransition(async () => {
      setError(null);

      const response = await fetch("/api/mars/audit/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          auditSessionId: auditSession.id,
          scannedValue: currentValue,
        }),
      });
      const payload = (await response.json()) as
        | ({ ok: true } & MarsAuditScanResult)
        | { ok: false; error: string };

      if (!response.ok || !payload.ok) {
        setError("error" in payload ? payload.error : "Failed to record scan.");
        setScanValue(currentValue);
        return;
      }

      setLastResult(payload);
      setSummary(payload.summary);
    });
  }

  function handleCompleteAudit() {
    if (!auditSession) {
      return;
    }

    startTransition(async () => {
      setError(null);

      const response = await fetch("/api/mars/audit/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auditSessionId: auditSession.id }),
      });
      const payload = (await response.json()) as
        | {
            ok: true;
            session: CompletedAuditSession;
            summary: MarsAuditSummary;
          }
        | { ok: false; error: string };

      if (!response.ok || !payload.ok) {
        setError("error" in payload ? payload.error : "Failed to complete audit session.");
        return;
      }

      setCompletedSession(payload.session);
      setSummary(payload.summary);
      setAuditSession(null);
      setScanValue("");
    });
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <CounterCard label="Total" value={summary.totalScans} />
        <CounterCard label="Matched" value={summary.matchedScans} tone="success" />
        <CounterCard label="Duplicates" value={summary.duplicateScans} tone="warning" />
        <CounterCard label="Unknown" value={summary.unknownScans} tone="error" />
      </div>

      <section className="card bg-base-100 border border-base-200 shadow-sm">
        <div className="card-body gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="card-title">Audit Session</h2>
              {auditSession ? (
                <p className="text-sm text-base-content/70">
                  Session {auditSession.id.slice(0, 8)} started{" "}
                  {new Date(auditSession.startedAt).toLocaleString()}
                </p>
              ) : completedSession ? (
                <p className="text-sm text-base-content/70">
                  Last session completed {new Date(completedSession.completedAt).toLocaleString()}
                </p>
              ) : (
                <p className="text-sm text-base-content/70">
                  Start a session to begin wedge-driven audit scanning.
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                className="btn btn-primary btn-lg"
                onClick={handleStartAudit}
                disabled={Boolean(auditSession) || isPending}
              >
                Start Audit
              </button>
              <button
                className="btn btn-outline btn-lg"
                onClick={handleCompleteAudit}
                disabled={!auditSession || isPending}
              >
                Finish Audit
              </button>
            </div>
          </div>

          <form onSubmit={handleSubmitScan} className="space-y-4">
            <label className="form-control">
              <span className="label-text mb-2">Scan Request Number</span>
              <input
                ref={inputRef}
                type="text"
                value={scanValue}
                onChange={(event) => setScanValue(event.target.value)}
                placeholder={auditSession ? "Scan barcode or enter request number" : "Start an audit first"}
                className="input input-bordered input-lg w-full text-xl"
                disabled={!auditSession || isPending}
                autoFocus
              />
            </label>
            <button
              type="submit"
              className="btn btn-accent btn-lg w-full sm:w-auto"
              disabled={!auditSession || !scanValue.trim() || isPending}
            >
              Record Scan
            </button>
          </form>

          {error ? (
            <div className="alert alert-error">
              <span>{error}</span>
            </div>
          ) : null}
        </div>
      </section>

      <section className="card bg-base-100 border border-base-200 shadow-sm">
        <div className="card-body">
          <h2 className="card-title">Last Scan Result</h2>
          {lastResult ? (
            <div className={`rounded-2xl border p-5 ${resultStyles(lastResult.result)}`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] opacity-70">Status</p>
                  <p className="text-2xl font-semibold">{resultLabel(lastResult.result)}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs uppercase tracking-[0.2em] opacity-70">Scanned</p>
                  <p className="text-xl font-semibold">{lastResult.scannedValue}</p>
                </div>
              </div>

              {lastResult.unit ? (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 mt-4 text-sm">
                  <FeedbackField label="Vendor" value={lastResult.unit.vendor} />
                  <FeedbackField label="Serial" value={lastResult.unit.serialNumber} />
                  <FeedbackField label="Model" value={lastResult.unit.modelNumber} />
                  <FeedbackField label="Request Status" value={lastResult.unit.requestStatus} />
                  <FeedbackField label="Return Status" value={lastResult.unit.returnStatus} />
                  <FeedbackField
                    label="Staged"
                    value={lastResult.unit.staged ? "Yes" : "No"}
                  />
                  <FeedbackField
                    label="Last Seen"
                    value={formatDate(lastResult.unit.lastAuditSeenAt)}
                  />
                  <FeedbackField
                    label="Duplicate"
                    value={lastResult.duplicateInSession ? "Yes" : "No"}
                  />
                </div>
              ) : (
                <p className="mt-4 text-sm opacity-80">
                  No matching MARS unit was found for this scan.
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-base-content/60">
              No scans recorded yet for this page session.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function CounterCard({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "success" | "warning" | "error";
}) {
  const tones = {
    default: "border-base-200 bg-base-100",
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

function FeedbackField({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="rounded-xl border border-current/10 bg-white/40 px-3 py-2">
      <p className="text-xs uppercase tracking-wide opacity-60">{label}</p>
      <p className="font-medium">{value || "—"}</p>
    </div>
  );
}

function resultLabel(result: MarsAuditScanResult["result"]) {
  switch (result) {
    case "matched":
      return "Matched";
    case "matched_staged":
      return "Matched + Staged";
    case "duplicate":
      return "Duplicate";
    case "unknown":
      return "Unknown";
  }
}

function resultStyles(result: MarsAuditScanResult["result"]) {
  switch (result) {
    case "matched":
      return "border-success/30 bg-success/10 text-success-content";
    case "matched_staged":
      return "border-info/30 bg-info/15 text-info-content";
    case "duplicate":
      return "border-warning/30 bg-warning/15 text-warning-content";
    case "unknown":
      return "border-error/30 bg-error/15 text-error-content";
  }
}

function formatDate(value: string | Date | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}
