// Dedicated cancellable owner for each engine. All runtime/model URLs stay on this origin.
let recognizer,
  engine,
  initMs = 0,
  runtime,
  busy = false;
const assets = [];
const origin = self.location.origin;
const base = `${origin}/scan-lab/vendor/`;
function progress(status, fraction) {
  self.postMessage({ type: "progress", engine, status, progress: fraction });
}
async function init(name) {
  engine = name;
  const start = performance.now();
  progress("Loading local runtime");
  if (engine === "tesseract") {
    const { createWorker } = await import(`${base}tesseract.mjs`);
    let failInitialization;
    const initializationFailure = new Promise((_, reject) => {
      failInitialization = reject;
    });
    recognizer = await Promise.race([
      createWorker("eng", 1, {
        workerPath: `${origin}/scan-lab/tesseract-host.js`,
        corePath: `${base}tesseract/core/`,
        langPath: `${base}tesseract/lang`,
        workerBlobURL: false,
        cacheMethod: "none",
        errorHandler: (error) => failInitialization(new Error(String(error))),
        logger: (m) => {
          if (m.asset) {
            assets.push(m.asset);
            self.postMessage({ type: "asset", engine, ...m.asset });
          }
          progress(m.status, m.progress);
        },
      }),
      initializationFailure,
    ]);
    await recognizer.setParameters({ tessedit_pageseg_mode: "3" });
    runtime = {
      backend: "WASM",
      worker: true,
      language: "eng",
      downloads: assets,
      version: "7.0.0",
    };
  } else if (engine === "paddle") {
    if (
      typeof OffscreenCanvas !== "function" ||
      typeof createImageBitmap !== "function"
    )
      throw new Error(
        "Paddle worker requires OffscreenCanvas and ImageBitmap; Tesseract remains available.",
      );
    const { PaddleOCR } = await import(`${base}paddle.mjs`);
    progress(
      "Downloading / compiling PP-OCRv5 mobile models (WASM, one thread)",
    );
    recognizer = await PaddleOCR.create({
      worker: {
        createWorker: () => {
          const worker = new Worker(`${origin}/scan-lab/paddle-host.mjs`, {
            type: "module",
            name: "temcoscan-paddle-runtime",
          });
          worker.addEventListener("message", ({ data }) => {
            if (data.type === "asset") {
              assets.push(data);
              self.postMessage({ ...data, engine });
            }
          });
          return worker;
        },
      },
      textDetectionModelName: "PP-OCRv5_mobile_det",
      textDetectionModelAsset: { url: `${base}paddle/PP-OCRv5_mobile_det.tar` },
      textRecognitionModelName: "PP-OCRv5_mobile_rec",
      textRecognitionModelAsset: {
        url: `${base}paddle/PP-OCRv5_mobile_rec.tar`,
      },
      textDetectionBatchSize: 1,
      textRecognitionBatchSize: 1,
      textDetLimitSideLen: 640,
      textDetLimitType: "max",
      textDetMaxSideLimit: 1600,
      ortOptions: {
        backend: "wasm",
        numThreads: 1,
        proxy: false,
        wasmPaths: `${base}ort/`,
      },
    });
    const summary = await recognizer.getInitializationSummary();
    runtime = {
      backend: summary.backend,
      detProvider: summary.detProvider,
      recProvider: summary.recProvider,
      assets: summary.assets,
      downloads: assets,
      ortVersion: "1.24.3",
      version: "0.4.2",
      threads: 1,
      worker: true,
    };
  } else throw new Error("Unknown engine");
  initMs = performance.now() - start;
  progress("Ready", 1);
  return { initMs, runtime };
}
async function recognize(blob) {
  const begin = performance.now();
  let detections, rawText;
  if (engine === "tesseract") {
    const { data } = await recognizer.recognize(
      new Uint8Array(await blob.arrayBuffer()),
      {},
      { text: true, blocks: true },
    );
    rawText = data.text;
    detections = (data.blocks ?? [])
      .flatMap((b) => (b.paragraphs ?? []).flatMap((p) => p.lines ?? []))
      .map((line) => ({
        kind: "ocr",
        rawText: line.text,
        confidence: line.confidence,
        confidenceScale: "0-100",
        boundingBox: line.bbox
          ? {
              x: line.bbox.x0,
              y: line.bbox.y0,
              width: line.bbox.x1 - line.bbox.x0,
              height: line.bbox.y1 - line.bbox.y0,
            }
          : undefined,
      }));
    if (!detections.length && data.text.trim())
      detections = [
        {
          kind: "ocr",
          rawText: data.text,
          confidence: data.confidence,
          confidenceScale: "0-100",
        },
      ];
  } else {
    const [result] = await recognizer.predict(blob);
    detections = result.items.map((item) => ({
      kind: "ocr",
      rawText: item.text,
      confidence: item.score,
      confidenceScale: "0-1",
      points: item.poly.map((p) => ({ x: p[0], y: p[1] })),
    }));
    rawText = result.items.map((item) => item.text).join("\n");
    runtime = {
      ...runtime,
      metrics: result.metrics,
      providers: result.runtime,
    };
  }
  return {
    engine,
    rawText,
    detections,
    initMs,
    inferenceMs: performance.now() - begin,
    runtime,
  };
}
self.onmessage = async ({ data }) => {
  if (busy) {
    self.postMessage({
      type: "error",
      id: data.id,
      error: "Worker busy: frames are not queued",
    });
    return;
  }
  busy = true;
  try {
    const output =
      data.type === "init"
        ? await init(data.engine)
        : await recognize(data.blob);
    progress("Ready", 1);
    self.postMessage({ type: "result", id: data.id, output });
  } catch (error) {
    progress("Error — reset engines to retry");
    self.postMessage({
      type: "error",
      id: data.id,
      error: error instanceof Error ? error.message : "OCR failed",
    });
  } finally {
    busy = false;
  }
};
