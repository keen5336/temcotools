"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type CaptureMode = "global" | "wedge-input" | "manual";

interface DiagnosticEvent {
  id: number;
  at: string;
  type: string;
  key: string;
  code: string;
  data: string;
  target: string;
  activeElement: string;
  deltaMs: number | null;
}

interface AcceptedScan {
  id: string;
  value: string;
  at: string;
  mode: CaptureMode;
}

interface ViewportMetrics {
  innerHeight: number;
  visualHeight: number;
  visualOffsetTop: number;
  baselineHeight: number;
}

const MODE_LABELS: Record<CaptureMode, string> = {
  global: "Global keys",
  "wedge-input": "No-keyboard input",
  manual: "Manual keyboard",
};

export default function ScannerDiagnosticClient() {
  const [mode, setMode] = useState<CaptureMode>("global");
  const [armed, setArmed] = useState(true);
  const [globalBuffer, setGlobalBuffer] = useState("");
  const [inputValue, setInputValue] = useState("");
  const [events, setEvents] = useState<DiagnosticEvent[]>([]);
  const [scans, setScans] = useState<AcceptedScan[]>([]);
  const [activeElement, setActiveElement] = useState("body");
  const [viewport, setViewport] = useState<ViewportMetrics>({
    innerHeight: 0,
    visualHeight: 0,
    visualOffsetTop: 0,
    baselineHeight: 0,
  });
  const [flash, setFlash] = useState<"idle" | "accepted">("idle");
  const [copyMessage, setCopyMessage] = useState("");

  const modeRef = useRef<CaptureMode>("global");
  const armedRef = useRef(true);
  const globalBufferRef = useRef("");
  const eventIdRef = useRef(0);
  const lastKeyAtRef = useRef<number | null>(null);
  const flashTimeoutRef = useRef<number | null>(null);
  const noKeyboardInputRef = useRef<HTMLInputElement | null>(null);
  const manualInputRef = useRef<HTMLInputElement | null>(null);
  const baselineHeightRef = useRef(0);

  const appendEvent = useCallback(
    (event: Omit<DiagnosticEvent, "id" | "at" | "deltaMs">) => {
      const now = performance.now();
      const previous = lastKeyAtRef.current;
      if (event.type === "keydown") lastKeyAtRef.current = now;

      const entry: DiagnosticEvent = {
        ...event,
        id: ++eventIdRef.current,
        at: new Date().toISOString(),
        deltaMs:
          event.type === "keydown" && previous !== null
            ? Math.round((now - previous) * 10) / 10
            : null,
      };
      setEvents((current) => [entry, ...current].slice(0, 120));
    },
    []
  );

  const acceptScan = useCallback((rawValue: string, source: CaptureMode) => {
    const value = rawValue.trim();
    if (!value) return;

    setScans((current) => [
      { id: crypto.randomUUID(), value, at: new Date().toISOString(), mode: source },
      ...current,
    ].slice(0, 12));
    setGlobalBuffer("");
    globalBufferRef.current = "";
    setInputValue("");
    setFlash("accepted");
    if (navigator.vibrate) navigator.vibrate(60);
    if (flashTimeoutRef.current !== null) {
      window.clearTimeout(flashTimeoutRef.current);
    }
    flashTimeoutRef.current = window.setTimeout(() => setFlash("idle"), 650);
  }, []);

  useEffect(() => {
    function addKeyboardEvent(event: KeyboardEvent) {
      appendEvent({
        type: event.type,
        key: displayKey(event.key),
        code: event.code,
        data: "",
        target: describeElement(event.target),
        activeElement: describeElement(document.activeElement),
      });

      if (
        event.type !== "keydown" ||
        modeRef.current !== "global" ||
        !armedRef.current ||
        event.repeat
      ) {
        return;
      }

      if (event.key === "Enter") {
        if (globalBufferRef.current) {
          event.preventDefault();
          event.stopPropagation();
          acceptScan(globalBufferRef.current, "global");
        }
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        globalBufferRef.current = "";
        setGlobalBuffer("");
        return;
      }

      if (event.key === "Backspace") {
        event.preventDefault();
        const next = globalBufferRef.current.slice(0, -1);
        globalBufferRef.current = next;
        setGlobalBuffer(next);
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
        const next = globalBufferRef.current + event.key;
        globalBufferRef.current = next;
        setGlobalBuffer(next);
      }
    }

    function addInputEvent(event: Event) {
      const inputEvent = event as InputEvent;
      appendEvent({
        type: event.type,
        key: "",
        code: "",
        data: inputEvent.data ?? "",
        target: describeElement(event.target),
        activeElement: describeElement(document.activeElement),
      });
    }

    function addFocusEvent(event: FocusEvent) {
      const current = describeElement(document.activeElement);
      setActiveElement(current);
      appendEvent({
        type: event.type,
        key: "",
        code: "",
        data: "",
        target: describeElement(event.target),
        activeElement: current,
      });
    }

    window.addEventListener("keydown", addKeyboardEvent, true);
    window.addEventListener("keyup", addKeyboardEvent, true);
    document.addEventListener("beforeinput", addInputEvent, true);
    document.addEventListener("input", addInputEvent, true);
    document.addEventListener("focusin", addFocusEvent, true);
    document.addEventListener("focusout", addFocusEvent, true);

    return () => {
      window.removeEventListener("keydown", addKeyboardEvent, true);
      window.removeEventListener("keyup", addKeyboardEvent, true);
      document.removeEventListener("beforeinput", addInputEvent, true);
      document.removeEventListener("input", addInputEvent, true);
      document.removeEventListener("focusin", addFocusEvent, true);
      document.removeEventListener("focusout", addFocusEvent, true);
    };
  }, [acceptScan, appendEvent]);

  useEffect(() => {
    function updateViewport() {
      const visualHeight = Math.round(window.visualViewport?.height ?? window.innerHeight);
      baselineHeightRef.current = Math.max(baselineHeightRef.current, visualHeight);
      setViewport({
        innerHeight: Math.round(window.innerHeight),
        visualHeight,
        visualOffsetTop: Math.round(window.visualViewport?.offsetTop ?? 0),
        baselineHeight: baselineHeightRef.current,
      });
      setActiveElement(describeElement(document.activeElement));
    }

    updateViewport();
    window.addEventListener("resize", updateViewport);
    window.visualViewport?.addEventListener("resize", updateViewport);
    window.visualViewport?.addEventListener("scroll", updateViewport);
    return () => {
      window.removeEventListener("resize", updateViewport);
      window.visualViewport?.removeEventListener("resize", updateViewport);
      window.visualViewport?.removeEventListener("scroll", updateViewport);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (flashTimeoutRef.current !== null) {
        window.clearTimeout(flashTimeoutRef.current);
      }
    };
  }, []);

  function selectMode(nextMode: CaptureMode) {
    modeRef.current = nextMode;
    setMode(nextMode);
    globalBufferRef.current = "";
    setGlobalBuffer("");
    setInputValue("");
    setCopyMessage("");

    window.setTimeout(() => {
      if (nextMode === "global") {
        (document.activeElement as HTMLElement | null)?.blur();
        setActiveElement(describeElement(document.activeElement));
      } else if (nextMode === "wedge-input") {
        noKeyboardInputRef.current?.focus();
      } else {
        manualInputRef.current?.focus();
      }
    }, 0);
  }

  function toggleArmed() {
    const next = !armedRef.current;
    armedRef.current = next;
    setArmed(next);
    globalBufferRef.current = "";
    setGlobalBuffer("");
    if (next && modeRef.current === "global") {
      (document.activeElement as HTMLElement | null)?.blur();
    }
  }

  function submitInput(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    acceptScan(inputValue, mode);
    window.setTimeout(() => {
      if (mode === "wedge-input") noKeyboardInputRef.current?.focus();
      if (mode === "manual") manualInputRef.current?.focus();
    }, 0);
  }

  async function copyDiagnostics() {
    const payload = {
      capturedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      mode,
      armed,
      activeElement,
      viewport,
      scans,
      events: [...events].reverse(),
    };
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    setCopyMessage("Copied");
    window.setTimeout(() => setCopyMessage(""), 1500);
    if (modeRef.current === "global") {
      (document.activeElement as HTMLElement | null)?.blur();
    }
  }

  const latestScan = scans[0] ?? null;
  const viewportInset = Math.max(0, viewport.baselineHeight - viewport.visualHeight);
  const globalReady = mode === "global" && armed;
  const statusText = globalReady
    ? "SCANNER ARMED — no input focus required"
    : mode === "global"
      ? "SCANNER PAUSED"
      : mode === "wedge-input"
        ? "FOCUSED INPUT — keyboard suppressed"
        : "MANUAL INPUT — keyboard expected";

  return (
    <div className="h-[100dvh] overflow-hidden bg-slate-950 text-slate-100">
      <header className="h-14 border-b border-slate-700 bg-slate-900 px-3 sm:px-4 flex items-center justify-between gap-3">
        <div className="min-w-0 flex items-center gap-3">
          <Link href="/" className="btn btn-sm btn-ghost text-slate-200">
            ← Exit
          </Link>
          <div className="min-w-0">
            <h1 className="font-bold leading-tight truncate">Scanner Diagnostic</h1>
            <p className="text-[11px] text-slate-400 truncate">Admin-only device test</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="hidden sm:inline text-slate-400">Viewport</span>
          <span className={`badge ${viewportInset > 100 ? "badge-warning" : "badge-ghost"}`}>
            {viewport.visualHeight}px {viewportInset > 100 ? `· keyboard ~${viewportInset}px` : "· clear"}
          </span>
        </div>
      </header>

      <main className="h-[calc(100dvh-3.5rem)] min-h-0 p-2 sm:p-4 grid grid-rows-[auto_minmax(0,1fr)] gap-2 sm:gap-4">
        <section className="rounded-xl border border-slate-700 bg-slate-900 p-2 sm:p-3 flex flex-wrap items-center gap-2">
          <div className="join">
            {(["global", "wedge-input", "manual"] as const).map((entry) => (
              <button
                key={entry}
                type="button"
                className={`btn btn-sm join-item ${mode === entry ? "btn-primary" : "btn-ghost"}`}
                onClick={() => selectMode(entry)}
              >
                {MODE_LABELS[entry]}
              </button>
            ))}
          </div>
          {mode === "global" ? (
            <button
              type="button"
              className={`btn btn-sm ${armed ? "btn-error btn-outline" : "btn-success"}`}
              onClick={toggleArmed}
            >
              {armed ? "Pause" : "Arm scanner"}
            </button>
          ) : null}
          <div className="ml-auto min-w-0 text-right">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">Active element</div>
            <div className="font-mono text-xs text-cyan-300 truncate max-w-64">{activeElement}</div>
          </div>
        </section>

        <div className="min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(0,1.05fr)_minmax(320px,0.95fr)] gap-2 sm:gap-4">
          <section className="min-h-0 grid grid-rows-[auto_auto_minmax(0,1fr)] gap-2 sm:gap-3">
            <div
              className={`rounded-2xl border-2 p-3 sm:p-5 transition-colors ${
                flash === "accepted"
                  ? "border-emerald-300 bg-emerald-500 text-emerald-950"
                  : globalReady || mode === "wedge-input"
                    ? "border-emerald-500 bg-emerald-950/60"
                    : mode === "manual"
                      ? "border-sky-500 bg-sky-950/60"
                      : "border-amber-500 bg-amber-950/60"
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] sm:text-xs font-bold uppercase tracking-[0.16em] opacity-75">
                    {flash === "accepted" ? "Scan accepted" : statusText}
                  </p>
                  <p className="text-2xl sm:text-4xl font-black break-all leading-tight mt-1">
                    {flash === "accepted"
                      ? latestScan?.value
                      : mode === "global"
                        ? globalBuffer || "READY"
                        : "READY"}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-3xl sm:text-5xl font-black">{scans.length}</div>
                  <div className="text-[10px] uppercase opacity-70">accepted</div>
                </div>
              </div>
            </div>

            {mode === "global" ? (
              <div className="rounded-xl border border-slate-700 bg-slate-900 p-3 text-xs sm:text-sm text-slate-300">
                No editable field is focused. Scan a barcode ending in Enter. If nothing appears in
                the event log, enable DataWedge Keystroke Output → <strong>Send Characters as Events</strong>.
              </div>
            ) : (
              <form className="rounded-xl border border-slate-700 bg-slate-900 p-3 flex gap-2" onSubmit={submitInput}>
                <input
                  ref={mode === "wedge-input" ? noKeyboardInputRef : manualInputRef}
                  type="text"
                  inputMode={mode === "wedge-input" ? "none" : "text"}
                  value={inputValue}
                  onChange={(event) => setInputValue(event.target.value)}
                  className="input input-bordered input-lg min-w-0 flex-1 bg-slate-950 text-xl font-bold"
                  placeholder={mode === "wedge-input" ? "Scan here; keyboard should stay hidden" : "Type or scan here"}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <button className="btn btn-primary btn-lg" disabled={!inputValue.trim()}>
                  Accept
                </button>
              </form>
            )}

            <div className="min-h-0 rounded-xl border border-slate-700 bg-slate-900 overflow-hidden flex flex-col">
              <div className="px-3 py-2 border-b border-slate-700 flex items-center justify-between gap-2">
                <div>
                  <h2 className="font-bold text-sm">Accepted scans</h2>
                  <p className="text-[11px] text-slate-400">A scanner beep alone does not count here.</p>
                </div>
                <button type="button" className="btn btn-xs btn-ghost" onClick={() => setScans([])}>
                  Clear
                </button>
              </div>
              <div className="min-h-0 overflow-auto">
                {scans.length ? (
                  <table className="table table-xs sm:table-sm">
                    <thead className="sticky top-0 bg-slate-900">
                      <tr><th>Value</th><th>Mode</th><th>Time</th></tr>
                    </thead>
                    <tbody>
                      {scans.map((scan) => (
                        <tr key={scan.id}>
                          <td className="font-mono font-bold break-all">{scan.value}</td>
                          <td>{MODE_LABELS[scan.mode]}</td>
                          <td className="whitespace-nowrap">{formatTime(scan.at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="h-full min-h-20 grid place-items-center text-sm text-slate-500">No accepted scans</div>
                )}
              </div>
            </div>
          </section>

          <section className="min-h-0 rounded-xl border border-slate-700 bg-slate-900 overflow-hidden flex flex-col">
            <div className="px-3 py-2 border-b border-slate-700 flex items-center justify-between gap-2">
              <div>
                <h2 className="font-bold text-sm">Browser event stream</h2>
                <p className="text-[11px] text-slate-400">Newest first · up to 120 events</p>
              </div>
              <div className="flex gap-1">
                <button type="button" className="btn btn-xs btn-ghost" onClick={() => setEvents([])}>Clear</button>
                <button type="button" className="btn btn-xs btn-outline" onClick={() => void copyDiagnostics()}>
                  {copyMessage || "Copy JSON"}
                </button>
              </div>
            </div>
            <div className="min-h-0 overflow-auto">
              {events.length ? (
                <table className="table table-xs">
                  <thead className="sticky top-0 bg-slate-900 z-[1]">
                    <tr><th>Event</th><th>Value</th><th>Δ</th><th>Target</th></tr>
                  </thead>
                  <tbody>
                    {events.map((event) => (
                      <tr key={event.id}>
                        <td className={event.type === "keydown" ? "text-cyan-300 font-semibold" : "text-slate-400"}>
                          {event.type}
                        </td>
                        <td className="font-mono max-w-32 break-all">{event.key || event.data || event.code || "—"}</td>
                        <td className="whitespace-nowrap">{event.deltaMs === null ? "—" : `${event.deltaMs}ms`}</td>
                        <td className="font-mono text-[10px] max-w-40 truncate" title={`${event.target}; active=${event.activeElement}`}>
                          {event.target}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="h-full min-h-32 grid place-items-center p-4 text-center text-sm text-slate-500">
                  Waiting for browser events
                </div>
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

function describeElement(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return target ? target.constructor.name : "none";
  const id = target.id ? `#${target.id}` : "";
  const name = target.getAttribute("name");
  const namePart = name ? `[name=${name}]` : "";
  const inputMode = target.getAttribute("inputmode");
  const inputModePart = inputMode ? `[inputmode=${inputMode}]` : "";
  return `${target.tagName.toLowerCase()}${id}${namePart}${inputModePart}`;
}

function displayKey(key: string) {
  if (key === " ") return "Space";
  return key;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}
