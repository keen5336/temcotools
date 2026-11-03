import assert from "node:assert/strict";
import test from "node:test";
import {
  clampRoi,
  fittedRect,
  pixelCrop,
  previewToSource,
  rotatePoint,
  sourceRoiToPreview,
} from "../lib/scan-lab/geometry";
import {
  characterErrorRate,
  DuplicateWindow,
  exportSession,
  extractCandidates,
  normalizeText,
  sessionCsv,
  summarize,
} from "../lib/scan-lab/results";
import { SingleFlight } from "../lib/scan-lab/scheduler";
import { CameraSource } from "../lib/scan-lab/camera";
import type { Attempt, EngineOutput } from "../lib/scan-lab/types";
const output: EngineOutput = {
  engine: "test",
  rawText: "LPN: 001O-IS5",
  detections: [
    { kind: "ocr", rawText: "LPN: 001O-IS5", normalizedText: "LPN: 001O-IS5" },
  ],
  initMs: 0,
  inferenceMs: 10,
};
const attempt: Attempt = {
  id: "one",
  timestamp: "2026-11-03T00:00:00Z",
  source: "upload",
  task: "ocr",
  outputs: [output],
  status: "success",
  isDuplicate: false,
  confirmed: false,
  cameraId: "private-id",
  cameraSettings: {
    deviceId: "private-id",
    groupId: "private-group",
    width: 640,
    height: 360,
  },
  error: "sensitive-label",
  groundTruth: "secret",
  timings: { captureMs: 1, preprocessMs: 2, totalMs: 12 },
};
test("contain letterbox, cover crop and invalid dimensions", () => {
  assert.deepEqual(
    fittedRect({ width: 1920, height: 1080 }, { width: 400, height: 400 }),
    { x: 0, y: 87.5, width: 400, height: 225 },
  );
  assert.equal(
    previewToSource(
      { x: 30, y: 20 },
      { width: 1920, height: 1080 },
      { width: 400, height: 400 },
    ),
    null,
  );
  assert.deepEqual(
    previewToSource(
      { x: 200, y: 200 },
      { width: 1920, height: 1080 },
      { width: 400, height: 400 },
    ),
    { x: 0.5, y: 0.5 },
  );
  assert.deepEqual(
    previewToSource(
      { x: 0, y: 200 },
      { width: 1920, height: 1080 },
      { width: 400, height: 400 },
      false,
      0,
      "cover",
    ),
    { x: 0.21875, y: 0.5 },
  );
  assert.throws(() =>
    fittedRect({ width: 0, height: 1 }, { width: 1, height: 1 }),
  );
});
test("ROI roundtrip across orientation, front mirror, landscape and portrait letterbox", () => {
  for (const source of [
    { width: 1920, height: 1080 },
    { width: 720, height: 1280 },
  ])
    for (const view of [
      { width: 380, height: 220 },
      { width: 800, height: 390 },
    ])
      for (const rotation of [0, 90, 180, 270])
        for (const mirror of [false, true]) {
          const roi = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
          const display = sourceRoiToPreview(
            roi,
            source,
            view,
            mirror,
            rotation,
          );
          const center = previewToSource(
            {
              x: display.x + display.width / 2,
              y: display.y + display.height / 2,
            },
            source,
            view,
            mirror,
            rotation,
          )!;
          assert.ok(Math.abs(center.x - 0.25) < 1e-10);
          assert.ok(Math.abs(center.y - 0.4) < 1e-10);
        }
  assert.deepEqual(rotatePoint({ x: 0.2, y: 0.3 }, 90), { x: 0.7, y: 0.2 });
});
test("source pixel ROI stays bounded including malicious persisted ROI", () => {
  assert.deepEqual(
    pixelCrop(
      { x: 0.1, y: 0.25, width: 0.8, height: 0.5 },
      { width: 1920, height: 1080 },
    ),
    { x: 192, y: 270, width: 1536, height: 540 },
  );
  assert.deepEqual(clampRoi({ x: NaN, y: -1, width: Infinity, height: 2 }), {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  });
  const p = pixelCrop(
    { x: 1, y: 1, width: 0.02, height: 0.02 },
    { width: 13, height: 9 },
  );
  assert.ok(p.x + p.width <= 13);
  assert.ok(p.y + p.height <= 9);
});
test("normalization preserves identity ambiguities and extraction is always unconfirmed", () => {
  assert.equal(
    normalizeText("  LPN:  001O-IS5\r\n aBc-008B \t"),
    "LPN: 001O-IS5\naBc-008B",
  );
  assert.deepEqual(
    extractCandidates("LPN: 001O-IS5\nModel: Q0-I1\nfree text\nLOCATION: A-01"),
    [
      { field: "LPN", candidate: "001O-IS5", requiresConfirmation: true },
      { field: "MODEL", candidate: "Q0-I1", requiresConfirmation: true },
      { field: "LOCATION", candidate: "A-01", requiresConfirmation: true },
    ],
  );
  assert.deepEqual(extractCandidates("LPN: \nS/N: <script>"), []);
});
test("duplicate window is engine-bound, refreshes and permits reintroduction after expiry", () => {
  const d = new DuplicateWindow(3000);
  assert.equal(d.check([output], 0), false);
  assert.equal(d.check([output], 1000), true);
  assert.equal(d.check([{ ...output, engine: "paddle" }], 1001), false);
  assert.equal(d.check([output], 5000), false);
  assert.equal(d.check([], 5001), false);
  d.clear();
  assert.equal(d.check([output], 5002), false);
});
test("privacy-safe JSON/CSV omit text and camera identifiers; CSV formula injection is escaped", () => {
  const j = JSON.stringify(exportSession([attempt]));
  for (const sensitive of [
    "001O",
    "private-id",
    "private-group",
    "sensitive-label",
    "secret",
  ])
    assert.equal(j.includes(sensitive), false);
  assert.equal(sessionCsv([attempt]).includes("001O"), false);
  assert.ok(
    sessionCsv([{ ...attempt, correction: '=HYPERLINK("x")' }], true).includes(
      "'=HYPERLINK",
    ),
  );
  assert.ok(JSON.stringify(exportSession([attempt], true)).includes("001O"));
});
test("CER counts substitutions, missing dashes, leading zeros and Unicode code points", () => {
  assert.equal(characterErrorRate("001O", "0010"), 0.25);
  assert.equal(characterErrorRate("A01", "A-01"), 0.25);
  assert.equal(characterErrorRate("01", "001"), 1 / 3);
  assert.equal(characterErrorRate("é", "é"), 0);
  assert.equal(characterErrorRate("a", ""), undefined);
});
test("summary gates percentile reporting and separates ROI/engine/resolution", () => {
  const n = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      ...attempt,
      id: String(i),
      groundTruth: output.rawText,
      timings: { captureMs: 0, preprocessMs: 0, totalMs: i + 1 },
    }));
  assert.equal(summarize(n(4))[0].medianMs, undefined);
  assert.equal(summarize(n(5))[0].medianMs, 3);
  assert.equal(summarize(n(19))[0].p95Ms, undefined);
  assert.equal(summarize(n(20))[0].p95Ms, 19);
  assert.equal(summarize(n(5))[0].exact, 5);
  assert.equal(
    summarize([
      attempt,
      { ...attempt, roi: { x: 0, y: 0, width: 0.5, height: 0.5 } },
    ]).length,
    2,
  );
});
test("single-flight drops concurrent work and late results, holds admission through cancellation", async () => {
  const f = new SingleFlight();
  let resolve!: (n: number) => void,
    calls = 0,
    published = 0,
    current = true;
  const first = f.run(
    async (valid) => {
      calls++;
      const result = await new Promise<number>((r) => {
        resolve = r;
      });
      current = valid();
      return result;
    },
    () => published++,
  );
  assert.equal(
    await f.run(
      async () => {
        calls++;
        return 2;
      },
      () => published++,
    ),
    false,
  );
  f.invalidate();
  assert.equal(f.running, true);
  resolve(1);
  await first;
  assert.equal(calls, 1);
  assert.equal(published, 0);
  assert.equal(current, false);
  assert.equal(f.running, false);
  await assert.rejects(() =>
    f.run(
      async () => {
        throw new Error("failed");
      },
      () => {},
    ),
  );
  assert.equal(f.running, false);
});
test("camera cancellation stops a late permission grant and switches stop prior tracks", async () => {
  let grant!: (s: MediaStream) => void,
    stops = 0;
  const requests: MediaStreamConstraints[] = [];
  const track = {
    stop() {
      stops++;
    },
    getSettings() {
      return { width: 640, height: 360 };
    },
    getCapabilities() {
      return {};
    },
    addEventListener() {},
  };
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
  const media = {
    getUserMedia: (c: MediaStreamConstraints) => {
      requests.push(c);
      return new Promise<MediaStream>((r) => {
        grant = r;
      });
    },
    enumerateDevices: async () => [],
  };
  const source = new CameraSource(media);
  const video = {
    srcObject: null,
    play: async () => {},
  } as unknown as HTMLVideoElement;
  const pending = source.start(video, "", 640, () => {});
  source.stop();
  grant(stream);
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(stops, 1);
  const next = source.start(video, "rear-id", 640, () => {});
  grant(stream);
  await next;
  assert.equal(video.srcObject, stream);
  const switched = source.start(video, "front-id", 1280, () => {});
  assert.equal(stops, 2);
  grant(stream);
  await switched;
  source.stop();
  assert.equal(stops, 3);
  assert.equal(requests[0].audio, false);
  assert.deepEqual((requests[1].video as MediaTrackConstraints).deviceId, {
    exact: "rear-id",
  });
});

test("permission and device enumeration failures release camera resources", async () => {
  const { cameraError } = await import("../lib/scan-lab/camera");
  const denied = new CameraSource({
    getUserMedia: async () => {
      throw new DOMException("denied", "NotAllowedError");
    },
    enumerateDevices: async () => [],
  });
  await assert.rejects(
    () => denied.start({} as HTMLVideoElement, "", 640, () => {}),
    { name: "NotAllowedError" },
  );
  assert.match(
    cameraError(new DOMException("denied", "NotAllowedError")),
    /permission denied/,
  );
  let stops = 0;
  const track = {
    stop() {
      stops++;
    },
    getSettings() {
      return {};
    },
    getCapabilities() {
      return {};
    },
    addEventListener() {},
  };
  const source = new CameraSource({
    getUserMedia: async () =>
      ({
        getTracks: () => [track],
        getVideoTracks: () => [track],
      }) as unknown as MediaStream,
    enumerateDevices: async () => {
      throw new Error("device enumeration failed");
    },
  });
  const video = {
    srcObject: null,
    play: async () => {},
  } as unknown as HTMLVideoElement;
  await assert.rejects(
    () => source.start(video, "", 640, () => {}),
    /enumeration/,
  );
  assert.equal(stops, 1);
  assert.equal(video.srcObject, null);
  await assert.rejects(() => source.torch(true), /not supported/);
});

test("OCR transport bounds concurrent dispatch, preserves raw text and rejects cancellation", async () => {
  const { OcrWorker } = await import("../lib/scan-lab/recognizers");
  const previous = globalThis.Worker;
  class FakeWorker {
    static instances: FakeWorker[] = [];
    onmessage?: (event: { data: unknown }) => void;
    onerror?: () => void;
    requests: { id: number; type: string }[] = [];
    terminated = false;
    constructor() {
      FakeWorker.instances.push(this);
    }
    postMessage(data: { id: number; type: string }) {
      this.requests.push(data);
    }
    terminate() {
      this.terminated = true;
    }
    emit(data: unknown) {
      this.onmessage?.({ data });
    }
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  try {
    const worker = new OcrWorker("tesseract", () => {});
    const first = worker.recognize(new Blob(["fixture"]));
    const fake = FakeWorker.instances[0];
    fake.emit({
      id: 1,
      type: "result",
      output: { initMs: 10, runtime: { backend: "WASM" } },
    });
    await new Promise(setImmediate);
    assert.equal(fake.requests.length, 2);
    await assert.rejects(
      worker.recognize(new Blob(["new frame"])),
      /already busy/,
    );
    fake.emit({
      id: 2,
      type: "result",
      output: {
        ...output,
        rawText: " 001O-I1S5 ",
        detections: [{ kind: "ocr", rawText: " 001O-I1S5 " }],
      },
    });
    const result = await first;
    assert.equal(result.rawText, " 001O-I1S5 ");
    assert.equal(result.detections[0].normalizedText, "001O-I1S5");
    const pending = worker.recognize(new Blob(["next frame"]));
    await new Promise(setImmediate);
    const rejected = assert.rejects(pending, /cancelled/);
    worker.dispose();
    await rejected;
    assert.equal(fake.terminated, true);
  } finally {
    globalThis.Worker = previous;
  }
});

test("wedge delivery never contributes invented inference latency", () => {
  const rows = Array.from({ length: 20 }, () => ({
    ...attempt,
    source: "wedge" as const,
  }));
  const metric = summarize(rows)[0];
  assert.equal(metric.medianMs, undefined);
  assert.equal(metric.p95Ms, undefined);
  assert.equal(metric.inferenceMedianMs, undefined);
});
