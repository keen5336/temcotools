"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type ScannerCaptureSource = "scanner" | "manual";

export interface ScannerFeedback {
  tone: "success" | "warning" | "error" | "info";
  title: string;
  detail?: string;
  value?: string;
}

interface ScannerCaptureProps {
  title: string;
  description: string;
  onScan: (value: string, source: ScannerCaptureSource) => void | Promise<void>;
  enabled?: boolean;
  disabledReason?: string;
  autoActivate?: boolean;
  startLabel?: string;
  manualPlaceholder?: string;
  count?: number;
  countLabel?: string;
  feedback?: ScannerFeedback | null;
  result?: React.ReactNode;
}

interface QueuedScan {
  value: string;
  source: ScannerCaptureSource;
}

export default function ScannerCapture({
  title,
  description,
  onScan,
  enabled = true,
  disabledReason,
  autoActivate = false,
  startLabel = "Enter Scanning Mode",
  manualPlaceholder = "Enter a barcode value",
  count = 0,
  countLabel = "captured",
  feedback,
  result,
}: ScannerCaptureProps) {
  const [active, setActive] = useState(() => autoActivate && enabled);
  const [armed, setArmed] = useState(true);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualValue, setManualValue] = useState("");
  const [buffer, setBuffer] = useState("");
  const [lastCaptured, setLastCaptured] = useState("");
  const [processing, setProcessing] = useState(false);
  const [queueDepth, setQueueDepth] = useState(0);
  const [captureError, setCaptureError] = useState("");
  const [pageActive, setPageActive] = useState(true);

  const bufferRef = useRef("");
  const queueRef = useRef<QueuedScan[]>([]);
  const processingRef = useRef(false);
  const manualInputRef = useRef<HTMLInputElement | null>(null);

  const drainQueue = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    setProcessing(true);

    try {
      while (queueRef.current.length) {
        const next = queueRef.current.shift();
        setQueueDepth(queueRef.current.length);
        if (!next) continue;
        try {
          await onScan(next.value, next.source);
        } catch (error) {
          setCaptureError(error instanceof Error ? error.message : "The scan could not be processed.");
        }
      }
    } finally {
      processingRef.current = false;
      setProcessing(false);
    }
  }, [onScan]);

  const enqueueScan = useCallback((rawValue: string, source: ScannerCaptureSource) => {
    const value = rawValue.trim();
    if (!value || !enabled) return;
    setCaptureError("");
    setLastCaptured(value);
    queueRef.current.push({ value, source });
    setQueueDepth(queueRef.current.length);
    if (navigator.vibrate) navigator.vibrate(55);
    void drainQueue();
  }, [drainQueue, enabled]);

  useEffect(() => {
    if (!active || !enabled || manualOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (!armed || event.repeat) return;

      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        const value = bufferRef.current;
        bufferRef.current = "";
        setBuffer("");
        enqueueScan(value, "scanner");
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        bufferRef.current = "";
        setBuffer("");
        return;
      }

      if (event.key === "Backspace") {
        event.preventDefault();
        const next = bufferRef.current.slice(0, -1);
        bufferRef.current = next;
        setBuffer(next);
        return;
      }

      if (
        event.key.length === 1 &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        const next = bufferRef.current + event.key;
        bufferRef.current = next;
        setBuffer(next);
      }
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [active, armed, enabled, enqueueScan, manualOpen]);

  useEffect(() => {
    if (!active) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    (document.activeElement as HTMLElement | null)?.blur();

    function updatePageState() {
      setPageActive(document.visibilityState === "visible" && document.hasFocus());
    }

    document.addEventListener("visibilitychange", updatePageState);
    window.addEventListener("focus", updatePageState);
    window.addEventListener("blur", updatePageState);
    updatePageState();

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("visibilitychange", updatePageState);
      window.removeEventListener("focus", updatePageState);
      window.removeEventListener("blur", updatePageState);
    };
  }, [active]);

  useEffect(() => {
    if (!manualOpen) return;
    const timeout = window.setTimeout(() => manualInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timeout);
  }, [manualOpen]);

  function beginScanning() {
    if (!enabled) return;
    setActive(true);
    setArmed(true);
    setManualOpen(false);
    setCaptureError("");
    bufferRef.current = "";
    setBuffer("");
  }

  function exitScanning() {
    setActive(false);
    setManualOpen(false);
    bufferRef.current = "";
    setBuffer("");
  }

  function toggleArmed() {
    setArmed((current) => !current);
    bufferRef.current = "";
    setBuffer("");
    window.setTimeout(() => (document.activeElement as HTMLElement | null)?.blur(), 0);
  }

  function submitManual(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    enqueueScan(manualValue, "manual");
    setManualValue("");
    setManualOpen(false);
    window.setTimeout(() => (document.activeElement as HTMLElement | null)?.blur(), 0);
  }

  const effectiveFeedback = captureError
    ? { tone: "error" as const, title: "Scan failed", detail: captureError, value: lastCaptured }
    : feedback;
  const toneClass = effectiveFeedback
    ? {
        success: "border-emerald-400 bg-emerald-950/70",
        warning: "border-amber-400 bg-amber-950/70",
        error: "border-rose-400 bg-rose-950/70",
        info: "border-sky-400 bg-sky-950/70",
      }[effectiveFeedback.tone]
    : "border-emerald-500 bg-emerald-950/60";

  return (
    <>
      <section className="rounded-2xl border-2 border-slate-700 bg-slate-950 text-slate-100 p-4 sm:p-5 shadow-lg">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className={`size-3 rounded-full ${enabled ? "bg-emerald-400" : "bg-slate-500"}`} />
              <h3 className="text-lg font-bold">{title}</h3>
            </div>
            <p className="text-sm text-slate-300 mt-1">{enabled ? description : disabledReason}</p>
          </div>
          <button
            type="button"
            className="btn btn-success btn-lg"
            disabled={!enabled}
            onClick={beginScanning}
          >
            {startLabel}
          </button>
        </div>
      </section>

      {active ? (
        <div className="fixed inset-0 z-[100] h-[100dvh] w-full max-w-[100vw] overflow-x-hidden overflow-y-hidden bg-slate-950 text-slate-100" data-testid="scanner-mode">
          <header className="h-14 w-full min-w-0 overflow-hidden border-b border-slate-700 bg-slate-900 px-1.5 sm:px-4 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1 sm:gap-3">
            <button type="button" className="btn btn-sm btn-ghost px-2 text-slate-200" onClick={exitScanning}>
              ← Exit
            </button>
            <div className="min-w-0 text-center">
              <h1 className="font-bold truncate">{title}</h1>
              <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400">
                Focus-free scanning mode
              </p>
            </div>
            <button
              type="button"
              className={`btn btn-sm px-2 ${armed ? "btn-error btn-outline" : "btn-success"}`}
              onClick={toggleArmed}
            >
              {armed ? "Pause" : "Resume"}
            </button>
          </header>

          <main className="h-[calc(100dvh-3.5rem)] min-h-0 w-full min-w-0 max-w-full overflow-x-hidden p-2 sm:p-4 grid grid-rows-[auto_minmax(0,1fr)_auto] gap-2 sm:gap-4">
            <section className={`rounded-2xl border-2 p-3 sm:p-5 ${
              !pageActive || !armed ? "border-rose-400 bg-rose-950/70" : toneClass
            } min-w-0 max-w-full overflow-hidden`} aria-live="polite">
              <div className="flex min-w-0 max-w-full items-start justify-between gap-2 sm:gap-4">
                <div className="min-w-0">
                  <p className="text-[10px] sm:text-xs font-bold uppercase tracking-[0.18em] opacity-75">
                    {!pageActive
                      ? "Page is not active — scans cannot be received"
                      : !armed
                        ? "Scanner paused"
                        : processing
                          ? queueDepth
                            ? `Processing · ${queueDepth} queued`
                            : "Processing scan"
                          : effectiveFeedback?.title ?? "Scanner armed"}
                  </p>
                  <p className="text-2xl sm:text-5xl font-black leading-tight break-all mt-1">
                    {buffer || effectiveFeedback?.value || lastCaptured || "READY"}
                  </p>
                  <p className="text-xs sm:text-sm opacity-80 mt-1 break-words">
                    {!pageActive || !armed
                      ? "Resume this screen before continuing."
                      : effectiveFeedback?.detail ?? "Scan a barcode. Enter completes and queues the scan."}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-3xl sm:text-6xl font-black">{count}</div>
                  <div className="text-[10px] uppercase opacity-70">{countLabel}</div>
                </div>
              </div>
            </section>

            <section className="min-h-0 min-w-0 max-w-full rounded-2xl border border-slate-700 bg-slate-900 overflow-x-hidden overflow-y-auto p-3 sm:p-5">
              {result ?? (
                <div className="h-full min-h-32 grid place-items-center text-center text-slate-400">
                  <div>
                    <p className="text-2xl font-bold text-slate-200">Ready for the first scan</p>
                    <p className="text-sm mt-2">Successful application feedback will stay visible here.</p>
                  </div>
                </div>
              )}
            </section>

            <footer className="min-w-0 max-w-full overflow-hidden rounded-xl border border-slate-700 bg-slate-900 p-2 flex items-center justify-between gap-2">
              <div className="text-xs text-slate-400 min-w-0 truncate">
                {processing || queueDepth ? "Do not leave while scans are processing." : "No text field is focused; the keyboard stays hidden."}
              </div>
              <button
                type="button"
                className="btn btn-sm btn-outline shrink-0"
                onClick={() => setManualOpen(true)}
                disabled={processing}
              >
                Manual Entry
              </button>
            </footer>
          </main>

          {manualOpen ? (
            <div className="fixed inset-0 z-[110] max-w-[100vw] overflow-x-hidden bg-black/70 p-3 grid place-items-center">
              <form className="card min-w-0 w-full max-w-lg bg-base-100 text-base-content shadow-2xl" onSubmit={submitManual}>
                <div className="card-body gap-4">
                  <div>
                    <h2 className="card-title">Manual Entry</h2>
                    <p className="text-sm text-base-content/70">The keyboard is expected only in this mode.</p>
                  </div>
                  <input
                    ref={manualInputRef}
                    type="text"
                    value={manualValue}
                    onChange={(event) => setManualValue(event.target.value)}
                    placeholder={manualPlaceholder}
                    className="input input-bordered input-lg w-full min-w-0 text-xl font-bold"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <div className="card-actions justify-end">
                    <button type="button" className="btn btn-ghost" onClick={() => setManualOpen(false)}>Cancel</button>
                    <button type="submit" className="btn btn-primary" disabled={!manualValue.trim()}>Submit</button>
                  </div>
                </div>
              </form>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
