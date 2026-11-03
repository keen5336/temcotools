import { normalizeText } from "./results";
import type {
  BarcodeEngine,
  Detection,
  EngineOutput,
  OcrEngine,
  Progress,
} from "./types";
interface NativeDetector {
  detect(source: HTMLCanvasElement): Promise<
    {
      rawValue: string;
      format: string;
      boundingBox?: DOMRectReadOnly;
      cornerPoints?: { x: number; y: number }[];
    }[]
  >;
}
interface NativeConstructor {
  new (options: { formats: string[] }): NativeDetector;
  getSupportedFormats(): Promise<string[]>;
}
interface ZxingRuntime {
  decode(c: HTMLCanvasElement): {
    rawText: string;
    symbology: string;
    points: { x: number; y: number }[];
  }[];
}
const preferredFormats = [
  "code_128",
  "code_39",
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "itf",
  "qr_code",
  "data_matrix",
  "pdf417",
];
function deadline<T>(promise: Promise<T>, milliseconds = 10000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(
          new Error("Barcode engine timed out; cancel and retry a smaller ROI"),
        ),
      milliseconds,
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
async function loadRuntime(url: string): Promise<ZxingRuntime> {
  return import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url);
}
export class OcrWorker {
  private worker?: Worker;
  private sequence = 0;
  private pending?: {
    id: number;
    resolve: (value: EngineOutput) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  };
  private ready?: Promise<void>;
  private readyInfo?: { initMs: number; runtime: unknown };
  constructor(
    readonly engine: OcrEngine,
    private progress: (p: Progress) => void,
  ) {}
  private request(
    type: "init" | "recognize",
    blob?: Blob,
  ): Promise<EngineOutput> {
    if (this.pending) return Promise.reject(new Error("OCR is already busy"));
    if (!this.worker) {
      this.worker = new Worker("/scan-lab/ocr-host.mjs", {
        type: "module",
        name: `temcoscan-${this.engine}`,
      });
      this.worker.onmessage = ({ data }) => {
        if (data.type === "progress") {
          this.progress(data);
          return;
        }
        if (data.type === "asset") {
          this.progress({
            engine: this.engine,
            status: `${data.path.split("/").pop()}: ${data.bytes} bytes, ${Math.round(data.downloadMs)} ms download`,
          });
          return;
        }
        if (!this.pending || data.id !== this.pending.id) return;
        const p = this.pending;
        this.pending = undefined;
        clearTimeout(p.timeout);
        if (data.type === "error")
          p.reject(new Error(`${this.engine}: ${String(data.error)}`));
        else p.resolve(data.output);
      };
      this.worker.onerror = () =>
        this.dispose(
          "OCR worker failed to load or execute; verify local runtime assets and browser WASM support",
        );
      this.worker.onmessageerror = () =>
        this.dispose("OCR worker returned an unreadable message");
    }
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timeout = setTimeout(
        () =>
          this.dispose("OCR timed out; reset engines and retry a smaller ROI"),
        type === "init" ? 120_000 : 60_000,
      );
      this.pending = { id, resolve, reject, timeout };
      try {
        this.worker!.postMessage({ type, id, engine: this.engine, blob });
      } catch (e) {
        this.dispose(e instanceof Error ? e.message : "OCR dispatch failed");
      }
    });
  }
  async recognize(blob: Blob): Promise<EngineOutput> {
    let initializedNow = false;
    if (!this.ready) {
      initializedNow = true;
      this.ready = this.request("init")
        .then((info) => {
          this.readyInfo = { initMs: info.initMs, runtime: info.runtime };
        })
        .catch((error) => {
          this.dispose("Initialization failed");
          throw error;
        });
    }
    await this.ready;
    const output = await this.request("recognize", blob);
    return {
      ...output,
      initMs: initializedNow ? (this.readyInfo?.initMs ?? output.initMs) : 0,
      detections: output.detections.map((d) => ({
        ...d,
        normalizedText: normalizeText(d.rawText),
      })),
    };
  }
  dispose(reason = "OCR cancelled") {
    if (this.pending) {
      clearTimeout(this.pending.timeout);
      this.pending.reject(new Error(reason));
      this.pending = undefined;
    }
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.onmessageerror = null;
      this.worker.terminate();
    }
    this.worker = undefined;
    this.ready = undefined;
    this.readyInfo = undefined;
  }
}
export async function barcode(
  canvas: HTMLCanvasElement,
  choice: BarcodeEngine,
): Promise<EngineOutput> {
  const begin = performance.now();
  const Constructor = (
    globalThis as typeof globalThis & { BarcodeDetector?: NativeConstructor }
  ).BarcodeDetector;
  if (choice !== "zxing" && Constructor) {
    try {
      const supported = await deadline(Constructor.getSupportedFormats());
      const formats = preferredFormats.filter((f) => supported.includes(f));
      if (!formats.length)
        throw new Error(
          "Native BarcodeDetector supports none of the selected formats",
        );
      const results = await deadline(
        new Constructor({ formats }).detect(canvas),
      );
      if (results.length || choice === "native")
        return {
          engine: "native-barcode",
          rawText: results.map((r) => r.rawValue).join("\n"),
          detections: results.map((r) => ({
            kind: "barcode",
            rawText: r.rawValue,
            normalizedText: normalizeText(r.rawValue),
            symbology: r.format,
            boundingBox: r.boundingBox
              ? {
                  x: r.boundingBox.x,
                  y: r.boundingBox.y,
                  width: r.boundingBox.width,
                  height: r.boundingBox.height,
                }
              : undefined,
            points: r.cornerPoints,
          })),
          initMs: 0,
          inferenceMs: performance.now() - begin,
          runtime: { supportedFormats: supported },
        };
    } catch (e) {
      if (choice === "native") throw e;
    }
  } else if (choice === "native")
    throw new Error(
      "Native BarcodeDetector is unavailable; select ZXing or Auto",
    );
  const loaded = performance.now();
  const runtime = await deadline(loadRuntime("/scan-lab/vendor/zxing.mjs"));
  const initMs = performance.now() - loaded;
  const detections: Detection[] = runtime.decode(canvas).map((d) => ({
    ...d,
    kind: "barcode",
    normalizedText: normalizeText(d.rawText),
  }));
  return {
    engine: "zxing",
    rawText: detections.map((d) => d.rawText).join("\n"),
    detections,
    initMs,
    inferenceMs: performance.now() - begin - initMs,
    runtime: {
      version: "0.2.1",
      maxResultsPerFrame: 1,
      note: "ZXing fallback returns one barcode per crop; use ROI for multiple labels",
    },
  };
}
