"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { SubmittedAuditSessionSummary } from "@/lib/mars/audit";
import ScannerCapture from "@/components/scanner/ScannerCapture";

interface MarsAuditClientProps {
  initialHistory: SubmittedAuditSessionSummary[];
}

interface LocalAuditDraft {
  id: string;
  deviceId: string;
  startedAt: string;
  scans: LocalAuditScan[];
}

interface LocalAuditScan {
  value: string;
  scannedAt: string;
  duplicate: boolean;
}

const DRAFT_STORAGE_KEY = "mars_audit_local_draft_v1";
const DEVICE_STORAGE_KEY = "mars_audit_device_id_v1";

export default function MarsAuditClient({ initialHistory }: MarsAuditClientProps) {
  const router = useRouter();
  const [draft, setDraft] = useState<LocalAuditDraft | null>(null);
  const [history, setHistory] = useState(initialHistory);
  const [lastScanned, setLastScanned] = useState<LocalAuditScan | null>(null);
  const [lastSighted, setLastSighted] = useState<{
    seenAt: string;
    unit: {
      requestNumber: string;
      orderNumber: string | null;
      vendor: string | null;
      serialNumber: string | null;
      modelNumber: string | null;
      dateRequested: string | null;
      returnStatus: string | null;
    };
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [isPending, startTransition] = useTransition();
  const draftRef = useRef<LocalAuditDraft | null>(null);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const deviceId = loadOrCreateDeviceId();
      const savedDraft = loadDraft();
      if (savedDraft && savedDraft.deviceId === deviceId) {
        draftRef.current = savedDraft;
        setDraft(savedDraft);
        setLastScanned(savedDraft.scans[0] ?? null);
      }
      setReady(true);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (draft) {
      window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
      return;
    }

    window.localStorage.removeItem(DRAFT_STORAGE_KEY);
  }, [draft, ready]);

  const summary = useMemo(() => {
    const scans = draft?.scans ?? [];
    const duplicateScans = scans.filter((scan) => scan.duplicate).length;

    return {
      totalScans: scans.length,
      duplicateScans,
      uniqueScans: scans.length - duplicateScans,
    };
  }, [draft]);

  function handleStartAudit() {
    const deviceId = loadOrCreateDeviceId();
    const nextDraft: LocalAuditDraft = {
      id: crypto.randomUUID(),
      deviceId,
      startedAt: new Date().toISOString(),
      scans: [],
    };

    setError(null);
    setLastScanned(null);
    draftRef.current = nextDraft;
    setDraft(nextDraft);
  }

  function handleDiscardDraft() {
    draftRef.current = null;
    setDraft(null);
    setLastScanned(null);
    setError(null);
  }

  function handleSubmitScan(value: string) {
    const currentDraft = draftRef.current;
    if (!currentDraft) {
      setError("Start an audit on this device before scanning.");
      return;
    }

    const normalized = normalizeScanValue(value);
    if (!normalized) {
      return;
    }

    const duplicate = currentDraft.scans.some((scan) => scan.value === normalized);
    const scan: LocalAuditScan = {
      value: normalized,
      scannedAt: new Date().toISOString(),
      duplicate,
    };

    setError(null);
    setLastScanned(scan);
    const nextDraft = { ...currentDraft, scans: [scan, ...currentDraft.scans] };
    draftRef.current = nextDraft;
    setDraft(nextDraft);
  }

  function handleSubmitAudit() {
    if (!draft || !draft.scans.length) {
      setError("This audit has no scans to submit.");
      return;
    }

    startTransition(async () => {
      setError(null);

      const response = await fetch("/api/mars/audit/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          localAuditId: draft.id,
          deviceId: draft.deviceId,
          startedAt: draft.startedAt,
          completedAt: new Date().toISOString(),
          scans: [...draft.scans].reverse().map((scan) => scan.value),
        }),
      });

      const payload = (await response.json()) as
        | {
            ok: true;
            session: {
              id: string;
              startedAt: string;
              completedAt: string | null;
            };
            summary: {
              totalScans: number;
              matchedScans: number;
              duplicateScans: number;
              unknownScans: number;
            };
          }
        | { ok: false; error: string };

      if (!response.ok || !payload.ok) {
        setError("error" in payload ? payload.error : "Failed to submit audit.");
        return;
      }

      const completedAt = payload.session.completedAt ?? new Date().toISOString();
      const nextHistoryItem: SubmittedAuditSessionSummary = {
        id: payload.session.id,
        startedAt: new Date(payload.session.startedAt),
        completedAt: new Date(completedAt),
        lastAmendedAt: new Date(completedAt),
        scanCount: payload.summary.totalScans,
        summary: payload.summary,
        startedBy: null,
        deviceId: draft.deviceId,
        localAuditId: draft.id,
        importBatchId: null,
        importFilename: null,
      };

      setHistory((current) => [nextHistoryItem, ...current]);
      draftRef.current = null;
      setDraft(null);
      setLastScanned(null);
      router.push(`/tools/mars/audit/${encodeURIComponent(payload.session.id)}`);
      router.refresh();
    });
  }

  async function handleQuickSighting(value: string) {
    const requestNumber = normalizeScanValue(value);
    if (!requestNumber) return;
    setError(null);
    const response = await fetch("/api/mars/audit/sighting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestNumber }),
    });
    const payload = (await response.json()) as
      | { ok: true; seenAt: string; unit: { requestNumber: string; orderNumber: string | null; vendor: string | null; serialNumber: string | null; modelNumber: string | null; dateRequested: string | null; returnStatus: string | null } }
      | { ok: false; error: string };
    if (!response.ok || !payload.ok) {
      const message = "error" in payload ? payload.error : "Failed to record item sighting.";
      setError(message);
      throw new Error(message);
    }
    setLastSighted(payload);
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <CounterCard label="Total Scans" value={summary.totalScans} tone="default" />
        <CounterCard label="Unique" value={summary.uniqueScans} tone="success" />
        <CounterCard label="Scanned Twice+" value={summary.duplicateScans} tone="warning" />
      </div>

      <section className="card bg-base-100 border border-base-200 shadow-sm">
        <div className="card-body gap-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="card-title">Scanner Draft</h2>
              {draft ? (
                <p className="text-sm text-base-content/70">
                  Local draft {draft.id.slice(0, 8)} started {formatDate(draft.startedAt)}. Stored
                  on this device until submitted.
                </p>
              ) : (
                <p className="text-sm text-base-content/70">
                  Start an audit to begin scanning locally on this Zebra device.
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                className="btn btn-primary"
                onClick={handleStartAudit}
                disabled={Boolean(draft) || isPending || !ready}
              >
                Start Audit
              </button>
              <button
                className="btn btn-outline"
                onClick={handleDiscardDraft}
                disabled={!draft || isPending}
              >
                Discard Draft
              </button>
              <button
                className="btn btn-accent"
                onClick={handleSubmitAudit}
                disabled={!draft || !draft.scans.length || isPending}
              >
                Submit Audit
              </button>
            </div>
          </div>

          {draft ? <ScannerCapture title="MARS Audit Scanning" description="Capture request numbers continuously without opening the keyboard." onScan={handleSubmitScan} enabled={!isPending} autoActivate count={summary.totalScans} countLabel="scans" feedback={lastScanned ? { tone: lastScanned.duplicate ? "warning" : "success", title: lastScanned.duplicate ? "Duplicate captured" : "Captured locally", value: lastScanned.value, detail: lastScanned.duplicate ? "Already present in this audit." : "Stored on this device." } : null} result={lastScanned ? <div className="grid h-full place-items-center text-center"><div><p className="text-xs uppercase tracking-[0.2em] text-slate-400">Most Recent Scan</p><p className="text-6xl sm:text-8xl font-black break-all mt-3">{lastScanned.value}</p><p className="mt-3 text-slate-300">{lastScanned.duplicate ? "Duplicate in this local audit draft." : "Stored locally on this device."}</p></div></div> : undefined} /> : <div className="alert alert-info"><span>Start an audit to enable scanning mode.</span></div>}

          {lastScanned ? (
            <div className={`rounded-2xl border p-5 ${lastScanned.duplicate ? "border-warning/40 bg-warning/10" : "border-success/40 bg-success/10"}`}>
              <p className="text-xs uppercase tracking-[0.2em] opacity-70 mb-2">Most Recent Scan</p>
              <p className="text-4xl font-semibold tracking-wide">{lastScanned.value}</p>
              <p className="mt-2 text-sm opacity-80">
                {lastScanned.duplicate ? "Duplicate in this local audit draft." : "Stored locally on this device."}
              </p>
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-base-300 p-5 text-base-content/60">
              The last scanned request number will stay prominent here so the operator can confirm
              it was captured.
            </div>
          )}

          {error ? (
            <div className="alert alert-error">
              <span>{error}</span>
            </div>
          ) : null}
        </div>
      </section>

      <section className="card bg-base-100 border border-base-200 shadow-sm">
        <div className="card-body gap-4">
          <div>
            <h2 className="card-title">Quick Sighting</h2>
            <p className="text-sm text-base-content/70">
              Record one item as seen without opening a full audit. Scan or type the Request
              Number and it will update that item&apos;s last-seen timestamps immediately.
            </p>
          </div>

          <ScannerCapture title="Quick Sighting" description="Scan one or more request numbers without starting a full audit." onScan={handleQuickSighting} enabled={!isPending} startLabel="Enter Quick Sighting Mode" count={lastSighted ? 1 : 0} countLabel="last sighting" feedback={lastSighted ? { tone: "success", title: "Sighting recorded", value: lastSighted.unit.requestNumber, detail: `Seen ${formatDate(lastSighted.seenAt)}` } : null} result={lastSighted ? <div><p className="text-5xl font-black break-all">{lastSighted.unit.requestNumber}</p><p className="mt-3 text-slate-300">H# {lastSighted.unit.orderNumber ?? "—"} · {lastSighted.unit.vendor ?? "—"} · Serial {lastSighted.unit.serialNumber ?? "—"}</p></div> : undefined} />

          {lastSighted ? (
            <div className="rounded-2xl border border-info/30 bg-info/10 p-4 text-sm">
              <p className="font-semibold text-base-content">{lastSighted.unit.requestNumber}</p>
              <p className="text-base-content/70">
                Seen {formatDate(lastSighted.seenAt)} | H# {lastSighted.unit.orderNumber ?? "—"} |
                Vendor {lastSighted.unit.vendor ?? "—"} | Serial {lastSighted.unit.serialNumber ?? "—"} |
                Model {lastSighted.unit.modelNumber ?? "—"} | Return Status {lastSighted.unit.returnStatus ?? "—"}
              </p>
            </div>
          ) : null}
        </div>
      </section>

      <section className="card bg-base-100 border border-base-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-base-200">
          <h2 className="text-lg font-semibold text-base-content">Current Draft Scans</h2>
          <p className="text-sm text-base-content/70 mt-1">
            Newest scan first. This list is saved in local storage and can be resumed on this
            device.
          </p>
        </div>
        <div className="max-h-[420px] overflow-auto">
          <table className="table table-zebra">
            <thead>
              <tr>
                <th>Scanned Value</th>
                <th>Time</th>
                <th>Duplicate</th>
              </tr>
            </thead>
            <tbody>
              {draft?.scans.length ? (
                draft.scans.map((scan, index) => (
                  <tr key={`${scan.scannedAt}-${scan.value}-${index}`}>
                    <td className={`font-medium ${index === 0 ? "text-lg" : ""}`}>{scan.value}</td>
                    <td>{formatDate(scan.scannedAt)}</td>
                  <td>{scan.duplicate ? "Scanned more than once" : "No"}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={3} className="text-center text-base-content/60 py-8">
                    No local scans yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card bg-base-100 border border-base-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-base-200">
          <h2 className="text-lg font-semibold text-base-content">Recent Audit Sessions</h2>
          <p className="text-sm text-base-content/70 mt-1">
            Open a session to amend scans, make manual corrections, and generate saved reports.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="table table-zebra">
            <thead>
              <tr>
                <th>Audit</th>
                <th>Submitted</th>
                <th>Scans</th>
                <th>Matched</th>
                <th>Unknown</th>
                <th>Scanned Twice+</th>
                <th>Import Snapshot</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {history.length ? (
                history.map((audit) => (
                  <tr key={audit.id}>
                    <td className="font-medium">{audit.id.slice(0, 8)}</td>
                    <td>{formatDate(audit.completedAt)}</td>
                    <td>{audit.scanCount}</td>
                    <td>{audit.summary.matchedScans}</td>
                    <td>{audit.summary.unknownScans}</td>
                    <td>{audit.summary.duplicateScans}</td>
                    <td>{audit.importFilename ?? "—"}</td>
                    <td>
                      <Link
                        href={`/tools/mars/audit/${encodeURIComponent(audit.id)}`}
                        className="btn btn-xs btn-outline"
                      >
                        Open Session
                      </Link>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={8} className="text-center text-base-content/60 py-8">
                    No completed audits yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
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
  tone?: "default" | "success" | "warning";
}) {
  const tones = {
    default: "border-base-200 bg-base-100",
    success: "border-success/30 bg-success/10",
    warning: "border-warning/30 bg-warning/10",
  };

  return (
    <div className={`rounded-2xl border p-4 ${tones[tone]}`}>
      <p className="text-xs uppercase tracking-wide text-base-content/60">{label}</p>
      <p className="text-3xl font-semibold text-base-content">{value}</p>
    </div>
  );
}

function loadDraft(): LocalAuditDraft | null {
  const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as LocalAuditDraft;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.deviceId !== "string" ||
      typeof parsed.startedAt !== "string" ||
      !Array.isArray(parsed.scans)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function loadOrCreateDeviceId() {
  const existing = window.localStorage.getItem(DEVICE_STORAGE_KEY);
  if (existing) return existing;

  const created = crypto.randomUUID();
  window.localStorage.setItem(DEVICE_STORAGE_KEY, created);
  return created;
}

function normalizeScanValue(value: string) {
  return value.trim().replace(/\s+/g, "");
}

function formatDate(value: string | Date | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}
