"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import CameraPreview, { RoiInputs } from "./CameraPreview";
import CaptureReview from "./CaptureReview";
import { CameraSource, cameraError } from "../../lib/scan-lab/camera";
import type { CameraInfo } from "../../lib/scan-lab/camera";
import {
  canvasBlob,
  captureOriginal,
  frameHash,
  imageFromBlob,
  preprocess,
} from "../../lib/scan-lab/capture";
import { clampRoi } from "../../lib/scan-lab/geometry";
import { barcode, OcrWorker } from "../../lib/scan-lab/recognizers";
import {
  DuplicateWindow,
  exportSession,
  extractCandidates,
  normalizeText,
  sessionCsv,
  summarize,
} from "../../lib/scan-lab/results";
import { SingleFlight } from "../../lib/scan-lab/scheduler";
import { DEFAULT_ROI, DEFAULT_TRANSFORM } from "../../lib/scan-lab/types";
import type {
  Attempt,
  BarcodeEngine,
  EngineOutput,
  OcrEngine,
  Progress,
  Rect,
  Source,
  Task,
  Transform,
} from "../../lib/scan-lab/types";
import styles from "./scan-lab.module.css";

const HISTORY_LIMIT = 200;
const rounded = (n: number) => `${Math.round(n)} ms`;
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function ScanLabClient() {
  const video = useRef<HTMLVideoElement>(null);
  const camera = useRef<CameraSource | null>(null);
  const dock = useRef<HTMLDivElement>(null), previewSlot = useRef<HTMLDivElement>(null), shutter = useRef<HTMLButtonElement>(null);
  const reviewUrl = useRef<string | undefined>(undefined);
  const [review, setReview] = useState<{ attempt: Attempt; frameUrl?: string } | null>(null);
  const [dockHeight, setDockHeight] = useState(0), [inlineHeight, setInlineHeight] = useState(270);
  const workers = useRef(new Map<OcrEngine, OcrWorker>());
  const flight = useRef(new SingleFlight());
  const duplicates = useRef(new DuplicateWindow());
  const mounted = useRef(true);
  const still = useRef<HTMLImageElement | null>(null);
  const stillGeneration = useRef(0);
  const stillObjectUrl = useRef<string | undefined>(undefined);
  const [input, setInput] = useState<Source>("camera");
  const [cameraInfo, setCameraInfo] = useState<CameraInfo | null>(null);
  const [cameraActive, setCameraActive] = useState(false),
    [starting, setStarting] = useState(false);
  const [deviceId, setDeviceId] = useState(""),
    [width, setWidth] = useState(1280);
  const [cameraStatus, setCameraStatus] = useState(
    "Camera stopped · HTTPS and permission required",
  );
  const [torch, setTorch] = useState(false);
  const [stillUrl, setStillUrl] = useState<string>();
  const [stillSize, setStillSize] = useState({ width: 0, height: 0 });
  const [roiEnabled, setRoiEnabled] = useState(false),
    [roi, setRoi] = useState<Rect>(DEFAULT_ROI),
    [rememberRoi, setRememberRoi] = useState(false);
  const [task, setTask] = useState<Task>("ocr"),
    [ocrEngine, setOcrEngine] = useState<OcrEngine>("tesseract"),
    [barcodeEngine, setBarcodeEngine] = useState<BarcodeEngine>("auto");
  const [transform, setTransform] = useState<Transform>(DEFAULT_TRANSFORM);
  const [continuous, setContinuous] = useState(false),
    [fps, setFps] = useState(1),
    [busy, setBusy] = useState(false);
  const [keepFrame, setKeepFrame] = useState(false),
    [includeText, setIncludeText] = useState(false);
  const [history, setHistory] = useState<Attempt[]>([]),
    [error, setError] = useState("");
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [groundTruth, setGroundTruth] = useState(""),
    [deviceNote, setDeviceNote] = useState("");
  const [wedgePrefix, setWedgePrefix] = useState(""),
    [wedgeSuffix, setWedgeSuffix] = useState(""),
    [wedgeValue, setWedgeValue] = useState("");

  const clearReview = useCallback(() => {
    if (reviewUrl.current) URL.revokeObjectURL(reviewUrl.current);
    reviewUrl.current = undefined;
    if (mounted.current) setReview(null);
  }, []);
  const dismissReview = () => {
    clearReview();
    requestAnimationFrame(() => { if (mounted.current) shutter.current?.focus({ preventScroll: true }); });
  };
  const dockActive = cameraActive && input === "camera";
  useEffect(() => {
    const element = dockActive ? dock.current : previewSlot.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const height = Math.ceil(element.getBoundingClientRect().height);
      if (dockActive) setDockHeight(height); else setInlineHeight(height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [dockActive]);
  const cancel = useCallback(() => {
    clearReview();
    flight.current.invalidate();
    stillGeneration.current++;
    workers.current.forEach((w) => w.dispose());
    workers.current.clear();
    if (mounted.current) {
      setContinuous(false);
      setProgress({});
    }
  }, [clearReview]);
  const stopCamera = useCallback(() => {
    camera.current?.stop();
    if (video.current) video.current.srcObject = null;
    if (mounted.current) {
      setCameraActive(false);
      setStarting(false);
      setTorch(false);
      setCameraStatus("Camera stopped");
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const onHidden = () => {
      if (document.hidden) {
        cancel();
        stopCamera();
      }
    };
    const onPageHide = () => {
      cancel();
      stopCamera();
    };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      mounted.current = false;
      cancel();
      stopCamera();
      if (stillObjectUrl.current) URL.revokeObjectURL(stillObjectUrl.current);
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [cancel, stopCamera]);
  const startCamera = useCallback(
    async (chosenId = deviceId, requestedWidth = width) => {
      cancel();
      setStarting(true);
      setCameraActive(false);
      setError("");
      setCameraStatus("Requesting camera permission…");
      if (!navigator.mediaDevices?.getUserMedia) {
        setError(
          "Camera requires HTTPS and a browser with getUserMedia. Image upload remains available.",
        );
        setStarting(false);
        return;
      }
      if (!camera.current)
        camera.current = new CameraSource(navigator.mediaDevices);
      try {
        if (!video.current) return;
        const info = await camera.current.start(
          video.current,
          chosenId,
          requestedWidth,
          () => {
            cancel();
            stopCamera();
            if (mounted.current)
              setError("Camera stream ended. Start camera to recover.");
          },
        );
        if (!mounted.current) return;
        setCameraInfo(info);
        setCameraActive(true);
        setInput("camera");
        setTorch(false);
        setCameraStatus(
          `Permission granted · ${info.devices.find((d) => d.deviceId === info.settings.deviceId)?.label || "Browser camera"} · started ${rounded(info.startupMs)}`,
        );
        if (rememberRoi) {
          try {
            const saved = localStorage.getItem(
              `temcoscan-roi:${info.settings.deviceId}:${info.settings.width}x${info.settings.height}`,
            );
            if (saved) setRoi(clampRoi(JSON.parse(saved)));
          } catch {
            /* storage is optional */
          }
        }
      } catch (e) {
        if (
          mounted.current &&
          !(e instanceof Error && e.name === "AbortError")
        ) {
          setError(cameraError(e));
          setCameraStatus("Camera unavailable");
        }
      } finally {
        if (mounted.current) setStarting(false);
      }
    },
    [cancel, deviceId, rememberRoi, stopCamera, width],
  );
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const refreshSize = () => {
      if (element.videoWidth && element.videoHeight)
        setCameraInfo((info) =>
          info
            ? {
                ...info,
                settings: {
                  ...info.settings,
                  width: element.videoWidth,
                  height: element.videoHeight,
                },
              }
            : info,
        );
    };
    element.addEventListener("resize", refreshSize);
    return () => element.removeEventListener("resize", refreshSize);
  }, []);
  const updateRoi = (value: Rect) => {
    setRoi(value);
    if (rememberRoi && cameraInfo) {
      try {
        localStorage.setItem(
          `temcoscan-roi:${cameraInfo.settings.deviceId}:${cameraInfo.settings.width}x${cameraInfo.settings.height}`,
          JSON.stringify(value),
        );
      } catch {
        /* storage optional */
      }
    }
  };
  const loadStill = async (blob: Blob, source: Source = "upload") => {
    const generation = ++stillGeneration.current;
    const image = await imageFromBlob(blob);
    if (!mounted.current || generation !== stillGeneration.current) return;
    if (stillObjectUrl.current) URL.revokeObjectURL(stillObjectUrl.current);
    still.current = image;
    stillObjectUrl.current = URL.createObjectURL(blob);
    setStillUrl(stillObjectUrl.current);
    setStillSize({ width: image.naturalWidth, height: image.naturalHeight });
    setInput(source);
  };
  const addAttempt = useCallback((a: Attempt) => {
    if (!mounted.current) return;
    const publishedAt = performance.now();
    setHistory((previous) => [a, ...previous].slice(0, HISTORY_LIMIT));
    requestAnimationFrame(() => {
      if (mounted.current)
        setHistory((items) =>
          items.map((item) =>
            item.id === a.id
              ? {
                  ...item,
                  timings: {
                    ...item.timings,
                    visibleMs:
                      a.timings.totalMs + performance.now() - publishedAt,
                  },
                }
              : item,
          ),
        );
    });
  }, []);
  const recognize = useCallback(
    async (compare = false, reviewCapture = false) => {
      let capturedBlob: Blob | undefined;
      const shouldReview = reviewCapture && input === "camera" && !continuous && !compare;
      if (flight.current.running) return;
      setBusy(true);
      setError("");
      try {
        await flight.current.run(
          async (isCurrent) => {
            const start = performance.now(),
              outputs: EngineOutput[] = [],
              errors: string[] = [];
            const attempt: Attempt = {
              id: crypto.randomUUID(),
              timestamp: new Date().toISOString(),
              source: input,
              task,
              cameraId:
                input === "camera" ? cameraInfo?.settings.deviceId : undefined,
              cameraSettings:
                input === "camera" ? cameraInfo?.settings : undefined,
              cameraStartupMs:
                input === "camera" ? cameraInfo?.startupMs : undefined,
              requestedResolution:
                input === "camera"
                  ? `${width}x${Math.round((width * 9) / 16)}`
                  : undefined,
              outputs,
              status: "miss",
              isDuplicate: false,
              confirmed: false,
              groundTruth: groundTruth || undefined,
              timings: { captureMs: 0, preprocessMs: 0, totalMs: 0 },
            };
            try {
              const source =
                input === "camera"
                  ? cameraActive
                    ? video.current
                    : null
                  : still.current;
              if (!source)
                throw new Error("Start the camera or upload a frame first");
              const original = captureOriginal(source);
              attempt.frameSize = {
                width: original.width,
                height: original.height,
              };
              attempt.timings.captureMs = performance.now() - start;
              if (!isCurrent())
                throw new DOMException("Capture cancelled", "AbortError");
              const prepStart = performance.now();
              const processed = preprocess(
                original,
                roiEnabled ? roi : undefined,
                transform,
              );
              attempt.roi = roiEnabled ? { ...roi } : undefined;
              attempt.transform = { ...transform };
              attempt.processedSize = {
                width: processed.width,
                height: processed.height,
              };
              attempt.frameId = await frameHash(processed);
              const blob = await canvasBlob(processed);
              if (shouldReview) capturedBlob = blob;
              attempt.timings.preprocessMs = performance.now() - prepStart;
              if (!isCurrent())
                throw new DOMException("Capture cancelled", "AbortError");
              if (keepFrame && input === "camera") {
                const retained = await canvasBlob(original);
                await loadStill(retained, "camera");
              }
              if (task !== "ocr") {
                try {
                  outputs.push(await barcode(processed, barcodeEngine));
                } catch (e) {
                  errors.push(
                    e instanceof Error ? e.message : "Barcode failed",
                  );
                }
              }
              if (task !== "barcode")
                for (const engine of compare
                  ? (["tesseract", "paddle"] as OcrEngine[])
                  : [ocrEngine]) {
                  if (!isCurrent()) break;
                  let worker = workers.current.get(engine);
                  if (!worker) {
                    worker = new OcrWorker(engine, (p) => {
                      if (mounted.current)
                        setProgress((previous) => ({
                          ...previous,
                          [p.engine]: p,
                        }));
                    });
                    workers.current.set(engine, worker);
                  }
                  try {
                    outputs.push(await worker.recognize(blob));
                  } catch (e) {
                    errors.push(e instanceof Error ? e.message : "OCR failed");
                    worker.dispose();
                    workers.current.delete(engine);
                  }
                }
              attempt.status = errors.length
                ? "error"
                : outputs.some((o) => o.detections.length)
                  ? "success"
                  : "miss";
              if (errors.length) attempt.error = errors.join("; ");
            } catch (e) {
              attempt.status = "error";
              attempt.error = e instanceof Error ? e.message : "Capture failed";
            }
            attempt.timings.totalMs = performance.now() - start;
            return attempt;
          },
          (a) => {
            a.isDuplicate = duplicates.current.check(
              a.outputs,
              performance.now(),
            );
            addAttempt(a);
            if (shouldReview) {
              clearReview();
              reviewUrl.current = capturedBlob ? URL.createObjectURL(capturedBlob) : undefined;
              setReview({ attempt: a, frameUrl: reviewUrl.current });
            }
            if (a.error) {
              setError(a.error);
              setContinuous(false);
            }
          },
        );
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [
      addAttempt,
      barcodeEngine,
      cameraActive,
      cameraInfo,
      clearReview,
      continuous,
      groundTruth,
      input,
      keepFrame,
      ocrEngine,
      roi,
      roiEnabled,
      task,
      transform,
      width,
    ],
  );
  useEffect(() => {
    if (!continuous) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await recognize();
      if (!stopped) timer = setTimeout(tick, 1000 / fps);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [continuous, fps, recognize]);
  const clear = () => {
    cancel();
    duplicates.current.clear();
    setHistory([]);
    setError("");
    setGroundTruth("");
    setWedgeValue("");
    if (stillObjectUrl.current) URL.revokeObjectURL(stillObjectUrl.current);
    stillObjectUrl.current = undefined;
    still.current = null;
    setStillUrl(undefined);
    setStillSize({ width: 0, height: 0 });
    setInput("camera");
    setIncludeText(false);
    setKeepFrame(false);
  };
  const last = history[0],
    metrics = summarize(history);
  const mirror =
    input === "camera" && cameraInfo?.settings.facingMode === "user";
  const sourceSize =
    input === "camera"
      ? {
          width: cameraInfo?.settings.width ?? 0,
          height: cameraInfo?.settings.height ?? 0,
        }
      : stillSize;
  const commitWedge = () => {
    if (!wedgeValue) return;
    if (
      (wedgePrefix && !wedgeValue.startsWith(wedgePrefix)) ||
      (wedgeSuffix && !wedgeValue.endsWith(wedgeSuffix))
    ) {
      setError("Wedge prefix/suffix did not match; value was not accepted");
      return;
    }
    const raw = wedgeValue.slice(
      wedgePrefix.length,
      wedgeSuffix ? -wedgeSuffix.length : undefined,
    );
    const output: EngineOutput = {
      engine: "keyboard-wedge",
      rawText: raw,
      detections: [
        { kind: "barcode", rawText: raw, normalizedText: normalizeText(raw) },
      ],
      initMs: 0,
      inferenceMs: 0,
    };
    addAttempt({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      source: "wedge",
      task: "barcode",
      outputs: [output],
      status: "success",
      isDuplicate: duplicates.current.check([output], performance.now()),
      confirmed: false,
      groundTruth: groundTruth || undefined,
      timings: { measured: false, captureMs: 0, preprocessMs: 0, totalMs: 0 },
    });
    setWedgeValue("");
  };
  return (
    <main className={styles.lab} style={dockActive ? { paddingBottom: dockHeight + 24 } : undefined}
      onFocusCapture={e => {
        if (!dockActive || review || dock.current?.contains(e.target)) return;
        const target = e.target;
        // Do not move pointer targets between pointer-down and click. Keyboard
        // focus (including text inputs) is revealed after the focus settles.
        requestAnimationFrame(() => {
          if (!mounted.current || document.activeElement !== target || !target.matches(":focus-visible")) return;
          const bounds = target.getBoundingClientRect(), top = dock.current?.getBoundingClientRect().top;
          if (top !== undefined && bounds.bottom > top - 12) window.scrollBy({ top: bounds.bottom - top + 24 });
        });
      }}>
      <span className={styles.badge}>EXPERIMENTAL · PLATFORM ADMIN</span>
      <h1>TemcoScan Lab</h1>
      <p>
        Local camera, barcode and printed-text test bench.{" "}
        <strong>No WMS writes.</strong>
      </p>
      <p className={styles.notice}>
        Check every candidate before trusting it. OCR never proves identity.
        Camera access may use the photographic camera, not the Zebra imager.
      </p>
      <div className={styles.grid}>
        <section className={styles.panel} aria-label="Capture controls">
          <h2>1 · Input</h2>
          <div className={styles.row}>
            <label>
              Input source
              <select
                aria-label="Input source"
                value={input}
                disabled={busy || continuous}
                onChange={(e) => {
                  setInput(e.target.value as Source);
                  setError("");
                }}
              >
                <option value="camera">Browser camera</option>
                <option value="upload">Image upload</option>
                <option value="replay" disabled={!stillUrl}>
                  Saved frame replay
                </option>
                <option value="wedge">Hardware keyboard wedge</option>
              </select>
            </label>
          </div>
          <div className={styles.row}>
            <button
              type="button"
              onClick={() => void startCamera()}
              disabled={starting || busy}
            >
              Start Camera
            </button>
            <button
              type="button"
              onClick={() => {
                cancel();
                stopCamera();
              }}
              disabled={!cameraActive && !starting}
            >
              Stop Camera
            </button>
          </div>
          <div className={styles.row}>
            <label>
              Exposed camera
              <select
                aria-label="Exposed camera"
                value={deviceId}
                disabled={busy || starting || continuous}
                onChange={(e) => {
                  setDeviceId(e.target.value);
                  if (cameraActive) void startCamera(e.target.value);
                }}
              >
                <option value="">Rear camera preferred</option>
                {cameraInfo?.devices.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Camera ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Requested resolution
              <select
                value={width}
                disabled={busy || starting || continuous}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  setWidth(value);
                  if (cameraActive) void startCamera(deviceId, value);
                }}
              >
                <option value={640}>640 × 360</option>
                <option value={1280}>1280 × 720</option>
                <option value={1920}>1920 × 1080</option>
              </select>
            </label>
          </div>
          <div className={styles.status} role="status">
            {cameraStatus}
            {cameraInfo && (
              <>
                <br />
                Requested {width} × {Math.round((width * 9) / 16)} · actual{" "}
                {cameraInfo.settings.width} × {cameraInfo.settings.height} @{" "}
                {cameraInfo.settings.frameRate?.toFixed(1) ?? "unknown"} FPS
              </>
            )}
          </div>
          <div ref={previewSlot} style={dockActive ? { minHeight: inlineHeight } : undefined}>
          <div ref={dock} className={dockActive ? styles.cameraDock : undefined}
            role={dockActive ? "region" : undefined} aria-label={dockActive ? "Live capture dock" : undefined}>
          <CameraPreview
            videoRef={video}
            stillUrl={input !== "camera" ? stillUrl : undefined}
            sourceSize={sourceSize}
            mirror={mirror}
            roi={roiEnabled ? roi : undefined}
            onRoi={updateRoi}
            docked={dockActive}
          />
          {dockActive && <>
            <div className={styles.dockActions}>
              <button ref={shutter} type="button" className={styles.primary}
                onClick={() => void recognize(false, true)} disabled={busy || continuous}>
                {busy ? "Recognizing locally…" : "Capture"}
              </button>
              <button type="button" onClick={() => { cancel(); stopCamera(); }}>Stop</button>
            </div>
            <div className={styles.dockStatus} role="status">
              {continuous ? "Continuous · results stay in history" : busy ? "Hold steady · processing captured frame" : `${task === "barcode" ? "Barcode" : task === "hybrid" ? "Barcode + OCR" : "OCR"} · single capture opens review`}
              {continuous && <button type="button" onClick={cancel}>Pause continuous</button>}
              {busy && !continuous && <button type="button" onClick={cancel}>Cancel capture</button>}
            </div>
          </>}
          </div>
          </div>
          {roiEnabled && <RoiInputs roi={roi} onRoi={updateRoi} />}
          <div className={styles.row}>
            <label className={styles.checks}>
              <input
                type="checkbox"
                checked={roiEnabled}
                onChange={(e) => setRoiEnabled(e.target.checked)}
                disabled={busy || continuous}
              />
              Crop to ROI
            </label>
            <label className={styles.checks}>
              <input
                type="checkbox"
                checked={rememberRoi}
                onChange={(e) => setRememberRoi(e.target.checked)}
              />
              Remember ROI per camera
            </label>
            {cameraActive && cameraInfo?.capabilities.torch && (
              <button
                type="button"
                onClick={() =>
                  void camera.current
                    ?.torch(!torch)
                    .then(() => setTorch((v) => !v))
                    .catch((e) => setError(e.message))
                }
              >
                {torch ? "Torch off" : "Torch on"}
              </button>
            )}
          </div>
          <label>
            Upload a local PNG, JPEG or WebP
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={busy || continuous}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  cancel();
                  void loadStill(file).catch((e) => setError(e.message));
                }
                e.target.value = "";
              }}
            />
          </label>
          <div className={styles.row}>
            <button
              type="button"
              disabled={busy || continuous}
              onClick={() =>
                void fetch("/scan-lab/fixtures/serial-clean.png")
                  .then((r) => {
                    if (!r.ok) throw new Error("Fixture missing");
                    return r.blob();
                  })
                  .then((b) => loadStill(b))
                  .catch((e) => setError(e.message))
              }
            >
              Load synthetic text fixture
            </button>
            <button
              type="button"
              disabled={busy || continuous}
              onClick={() =>
                void fetch("/scan-lab/fixtures/code128.png")
                  .then((r) => {
                    if (!r.ok) throw new Error("Fixture missing");
                    return r.blob();
                  })
                  .then((b) => loadStill(b))
                  .catch((e) => setError(e.message))
              }
            >
              Load Code 128 fixture
            </button>
          </div>
          <label className={styles.checks}>
            <input
              type="checkbox"
              checked={keepFrame}
              onChange={(e) => setKeepFrame(e.target.checked)}
            />
            Keep next camera frames in session for replay (last frame only)
          </label>
          {stillUrl && (
            <div className={styles.row}>
              <button
                type="button"
                onClick={() => setInput("replay")}
                disabled={busy || continuous}
              >
                Replay retained original
              </button>
              <button
                type="button"
                onClick={() => {
                  const a = document.createElement("a");
                  a.href = stillUrl;
                  a.download = "temcoscan-frame.png";
                  a.click();
                }}
              >
                Save frame image
              </button>
            </div>
          )}
          <details>
            <summary>Camera settings and capabilities</summary>
            <pre>
              {JSON.stringify(
                cameraInfo
                  ? {
                      settings: cameraInfo.settings,
                      capabilities: cameraInfo.capabilities,
                    }
                  : "Start camera to inspect actual values",
                null,
                2,
              )}
            </pre>
          </details>
        </section>
        <section className={styles.panel} aria-label="Recognition controls">
          <h2>2 · Recognition</h2>
          <div className={styles.row}>
            <label>
              Task
              <select
                aria-label="Task"
                value={task}
                disabled={busy || continuous}
                onChange={(e) => setTask(e.target.value as Task)}
              >
                <option value="ocr">Printed text OCR</option>
                <option value="barcode">Barcode</option>
                <option value="hybrid">Barcode + OCR, same frame</option>
              </select>
            </label>
          </div>
          <div className={styles.row}>
            <label>
              OCR backend
              <select
                aria-label="OCR backend"
                value={ocrEngine}
                disabled={busy || continuous}
                onChange={(e) => setOcrEngine(e.target.value as OcrEngine)}
              >
                <option value="tesseract">Tesseract 7 · English WASM</option>
                <option value="paddle">PaddleOCR 0.4.2 · v5 mobile WASM</option>
              </select>
            </label>
            <label>
              Barcode backend
              <select
                aria-label="Barcode backend"
                value={barcodeEngine}
                disabled={busy || continuous}
                onChange={(e) =>
                  setBarcodeEngine(e.target.value as BarcodeEngine)
                }
              >
                <option value="auto">Native → ZXing fallback</option>
                <option value="native">Native BarcodeDetector only</option>
                <option value="zxing">ZXing software only</option>
              </select>
            </label>
          </div>
          <p className={styles.muted}>
            Engines load only on capture. Paddle uses WASM, one thread. ZXing
            returns one barcode per ROI; native may return several. Barcode
            confidence is not supplied.
          </p>
          <details>
            <summary>Preprocessing comparison controls</summary>
            <div className={styles.row}>
              <label>
                Clockwise rotation
                <select
                  aria-label="Rotation"
                  value={transform.rotation}
                  disabled={busy || continuous}
                  onChange={(e) =>
                    setTransform({
                      ...transform,
                      rotation: Number(e.target.value) as Transform["rotation"],
                    })
                  }
                >
                  {[0, 90, 180, 270].map((v) => (
                    <option value={v} key={v}>
                      {v}°
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Maximum processed edge
                <select
                  value={transform.maxEdge}
                  disabled={busy || continuous}
                  onChange={(e) =>
                    setTransform({
                      ...transform,
                      maxEdge: Number(e.target.value),
                    })
                  }
                >
                  {[640, 1280, 1600, 1920].map((v) => (
                    <option value={v} key={v}>
                      {v}px
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className={styles.row}>
              <label className={styles.checks}>
                <input
                  type="checkbox"
                  checked={transform.grayscale}
                  disabled={busy || continuous}
                  onChange={(e) =>
                    setTransform({ ...transform, grayscale: e.target.checked })
                  }
                />
                Grayscale
              </label>
              <label className={styles.checks}>
                <input
                  type="checkbox"
                  checked={transform.threshold}
                  disabled={busy || continuous}
                  onChange={(e) =>
                    setTransform({ ...transform, threshold: e.target.checked })
                  }
                />
                Threshold 128
              </label>
              <label>
                Contrast
                <input
                  type="range"
                  min={0.5}
                  max={3}
                  step={0.1}
                  value={transform.contrast}
                  disabled={busy || continuous}
                  onChange={(e) =>
                    setTransform({
                      ...transform,
                      contrast: Number(e.target.value),
                    })
                  }
                />
                {transform.contrast}×
              </label>
            </div>
          </details>
          <label>
            Ground truth for next attempts (optional, exact text)
            <textarea
              rows={2}
              value={groundTruth}
              maxLength={2000}
              onChange={(e) => setGroundTruth(e.target.value)}
              placeholder="Use synthetic or de-identified labels"
            />
          </label>
          {input === "wedge" ? (
            <div>
              <label>
                Wedge prefix
                <input
                  value={wedgePrefix}
                  onChange={(e) => setWedgePrefix(e.target.value)}
                />
              </label>
              <label>
                Wedge suffix (before Enter)
                <input
                  value={wedgeSuffix}
                  onChange={(e) => setWedgeSuffix(e.target.value)}
                />
              </label>
              <label>
                Isolated wedge input · Enter to record
                <input
                  aria-label="Isolated wedge input"
                  value={wedgeValue}
                  onChange={(e) => setWedgeValue(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitWedge();
                    }
                  }}
                />
              </label>
              <small>
                Records keyboard delivery only. It cannot trigger operational
                actions; decode latency is unknown.
              </small>
            </div>
          ) : (
            <>
              {!dockActive && <button
                type="button"
                className={styles.primary}
                onClick={() => void recognize()}
                disabled={
                  busy ||
                  continuous ||
                  (input === "camera" ? !cameraActive : !stillUrl)
                }
              >
                {busy ? "Recognizing locally…" : "Scan / Capture"}
              </button>}
              <div className={styles.row}>
                <button
                  type="button"
                  disabled={
                    busy ||
                    continuous ||
                    task === "barcode" ||
                    (input === "camera" ? !cameraActive : !stillUrl)
                  }
                  onClick={() => void recognize(true)}
                >
                  Compare Tesseract + Paddle · same frame
                </button>
                <button type="button" onClick={cancel}>
                  Cancel / reset engines
                </button>
              </div>
              <div className={styles.row}>
                <label className={styles.checks}>
                  <input
                    type="checkbox"
                    checked={continuous}
                    disabled={
                      input !== "camera" ||
                      !cameraActive ||
                      (busy && !continuous)
                    }
                    onChange={(e) => {
                      setContinuous(e.target.checked);
                      if (!e.target.checked) flight.current.invalidate();
                    }}
                  />
                  Continuous camera capture
                </label>
                <label>
                  Maximum target
                  <select
                    value={fps}
                    disabled={continuous}
                    onChange={(e) => setFps(Number(e.target.value))}
                  >
                    {[1, 2, 3, 4, 5].map((v) => (
                      <option value={v} key={v}>
                        {v} FPS
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <small>
                One frame in flight, no queue. Capture interval follows
                inference; actual throughput may be lower. Duplicates are marked
                for 3 seconds.
              </small>
            </>
          )}
          <div aria-live="polite">
            {Object.values(progress).map((p) => (
              <div className={styles.status} key={p.engine}>
                {p.engine}: {p.status}
                {p.progress !== undefined && (
                  <progress max={1} value={p.progress} />
                )}
              </div>
            ))}
          </div>
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
          <div className={styles.row}>
            <button type="button" onClick={clear}>
              Clear session / frames
            </button>
            <button
              type="button"
              onClick={() => {
                clear();
                stopCamera();
                setRoi(DEFAULT_ROI);
                setRoiEnabled(false);
                setTransform(DEFAULT_TRANSFORM);
                setDeviceNote("");
              }}
            >
              Reset lab
            </button>
          </div>
        </section>
        <section className={styles.panel}>
          <h2>3 · Last result</h2>
          {!last ? (
            <p>Capture a label to begin. Results remain in this tab.</p>
          ) : (
            <>
              <p>
                <strong>{last.status.toUpperCase()}</strong>{" "}
                {last.isDuplicate ? "· duplicate" : ""} ·{" "}
                {last.source === "wedge"
                  ? "timing unavailable"
                  : rounded(last.timings.totalMs)}{" "}
                · {last.timestamp}
              </p>
              {last.outputs.map((o, i) => (
                <div className={styles.result} key={i}>
                  <strong>{o.engine}</strong> ·{" "}
                  {last.source === "wedge"
                    ? "keyboard delivery only; decode timing unavailable"
                    : `init ${rounded(o.initMs)} · inference ${rounded(o.inferenceMs)}`}
                  <pre aria-label={`${o.engine} raw text`}>
                    {o.rawText || "No text / barcode detected"}
                  </pre>
                  <small>
                    Normalized candidate:{" "}
                    {normalizeText(o.rawText) || "(empty)"}
                  </small>
                  {o.detections.map((d, j) => (
                    <p key={j}>
                      {d.symbology ?? "OCR line"}: {d.rawText}
                      {d.confidence !== undefined
                        ? ` · confidence ${d.confidence.toFixed(2)} (${d.confidenceScale})`
                        : ""}
                      {d.boundingBox
                        ? ` · box ${JSON.stringify(d.boundingBox)}`
                        : ""}
                      {d.points ? ` · points ${JSON.stringify(d.points)}` : ""}
                    </p>
                  ))}
                  {extractCandidates(o.rawText).map((c, j) => (
                    <p key={`c${j}`} className={styles.notice}>
                      {c.field}: {c.candidate} · operator confirmation required
                    </p>
                  ))}
                </div>
              ))}
              {last.error && <p className={styles.error}>{last.error}</p>}
              <small>
                Boxes / points use processed-frame pixels after ROI, resize and
                rotation.
              </small>
              <label>
                Manual correction (never overwrites raw)
                <input
                  maxLength={2000}
                  value={last.correction ?? ""}
                  onChange={(e) =>
                    setHistory((items) =>
                      items.map((a, i) =>
                        i === 0
                          ? {
                              ...a,
                              correction: e.target.value,
                              confirmed: false,
                            }
                          : a,
                      ),
                    )
                  }
                />
              </label>
              <label className={styles.checks}>
                <input
                  type="checkbox"
                  checked={last.confirmed}
                  onChange={(e) =>
                    setHistory((items) =>
                      items.map((a, i) =>
                        i === 0 ? { ...a, confirmed: e.target.checked } : a,
                      ),
                    )
                  }
                />
                I checked this result against the label
              </label>
            </>
          )}
        </section>
        <section className={styles.panel}>
          <h2>
            Session history · {history.length}/{HISTORY_LIMIT}
          </h2>
          <p className={styles.muted}>
            Oldest attempts are dropped at the limit. Raw images are never
            attached to history.
          </p>
          <div className={styles.history} data-testid="scan-history">
            {history.map((a) => (
              <details className={styles.attempt} key={a.id}>
                <summary>
                  {a.status} {a.isDuplicate ? "· duplicate" : ""} ·{" "}
                  {a.outputs.map((o) => o.engine).join(" + ") || "capture"} ·{" "}
                  {a.source} ·{" "}
                  {a.source === "wedge"
                    ? "untimed"
                    : rounded(a.timings.totalMs)}{" "}
                  · {new Date(a.timestamp).toLocaleTimeString()}
                </summary>
                <pre>{JSON.stringify(a, null, 2)}</pre>
              </details>
            ))}
          </div>
        </section>
        <section className={`${styles.panel} ${styles.wide}`}>
          <h2>4 · Measurements & local export</h2>
          <p className={styles.muted}>
            Capture to the next render frame, including cold initialization.
            Paired comparisons include both engines in this total; inference is
            measured separately. Median requires ≥5 attempts; p95 ≥20 per
            engine/source/camera/resolution/ROI/transform group. This is a
            retained-session sample, not a hardware benchmark.
          </p>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {[
                    "Engine / source",
                    "Frame / ROI",
                    "n / reads / errors",
                    "Duplicates",
                    "Median / p95",
                    "Inference median / p95",
                    "Corrected / confirmed",
                    "Exact / truth n",
                    "Mean CER",
                  ].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {metrics.map((m, i) => (
                  <tr key={i}>
                    <td>
                      {m.engine} / {m.source}
                    </td>
                    <td>
                      {m.resolution}
                      <br />
                      {m.roi}
                    </td>
                    <td>
                      {m.n} / {m.successes} / {m.errors}
                    </td>
                    <td>{m.duplicates}</td>
                    <td>
                      {m.medianMs === undefined
                        ? "pending"
                        : rounded(m.medianMs)}{" "}
                      / {m.p95Ms === undefined ? "pending" : rounded(m.p95Ms)}
                    </td>
                    <td>
                      {m.inferenceMedianMs === undefined
                        ? "pending"
                        : rounded(m.inferenceMedianMs)}{" "}
                      /{" "}
                      {m.inferenceP95Ms === undefined
                        ? "pending"
                        : rounded(m.inferenceP95Ms)}
                    </td>
                    <td>
                      {m.corrected} / {m.confirmed}
                    </td>
                    <td>
                      {m.exact} / {m.groundTruthN}
                    </td>
                    <td>
                      {m.cer === undefined
                        ? "n/a"
                        : `${(m.cer * 100).toFixed(1)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label>
            Device/browser/run notes (session only)
            <input
              value={deviceNote}
              maxLength={1000}
              onChange={(e) => setDeviceNote(e.target.value)}
              placeholder="Exact Zebra model, Android, Chrome, lighting; no customer data"
            />
          </label>
          <div className={styles.row}>
            <label className={styles.checks}>
              <input
                type="checkbox"
                checked={includeText}
                onChange={(e) => setIncludeText(e.target.checked)}
              />
              Include recognized text, ground truth and corrections in exports
            </label>
          </div>
          <div className={styles.row}>
            <button
              type="button"
              disabled={!history.length}
              onClick={() =>
                download(
                  new Blob(
                    [
                      JSON.stringify(
                        {
                          ...exportSession(history, includeText),
                          deviceNote: includeText ? deviceNote : undefined,
                        },
                        null,
                        2,
                      ),
                    ],
                    { type: "application/json" },
                  ),
                  "temcoscan-session.json",
                )
              }
            >
              Export JSON
            </button>
            <button
              type="button"
              disabled={!history.length}
              onClick={() =>
                download(
                  new Blob([sessionCsv(history, includeText)], {
                    type: "text/csv;charset=utf-8",
                  }),
                  "temcoscan-session.csv",
                )
              }
            >
              Export CSV
            </button>
          </div>
          <p className={styles.muted}>
            Default exports omit text, freeform notes, error messages, camera
            identifiers and pictures. Local inference still needs runtime/model
            downloads. No offline, battery/heat, Zebra or iPhone qualification
            claim.
          </p>
        </section>
      </div>
      {review && <CaptureReview attempt={review.attempt} frameUrl={review.frameUrl} onDismiss={dismissReview} />}
    </main>
  );
}
