import type { Attempt, EngineOutput } from "./types";
/** Only whitespace normalization; preserve case, punctuation and every ambiguous character. */
export function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((s) => s.trim().replace(/[\t ]+/g, " "))
    .join("\n")
    .trim();
}
export function extractCandidates(
  raw: string,
): { field: string; candidate: string; requiresConfirmation: true }[] {
  const found: {
    field: string;
    candidate: string;
    requiresConfirmation: true;
  }[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m =
      /^\s*(LPN|S\/N|SERIAL|MODEL|LOCATION)\s*[:#=]\s*([A-Za-z0-9][A-Za-z0-9 ._\/-]{1,79})\s*$/i.exec(
        line,
      );
    if (m)
      found.push({
        field: m[1].toUpperCase(),
        candidate: m[2].trim(),
        requiresConfirmation: true,
      });
  }
  return found;
}
export class DuplicateWindow {
  private seen = new Map<string, number>();
  constructor(private windowMs = 3000) {}
  check(outputs: EngineOutput[], now: number): boolean {
    for (const [key, at] of this.seen)
      if (now - at >= this.windowMs) this.seen.delete(key);
    const keys = outputs
      .flatMap((o) =>
        o.detections.map(
          (d) => `${o.engine}|${d.kind}|${d.symbology ?? ""}|${d.rawText}`,
        ),
      )
      .filter(Boolean);
    const duplicate = keys.length > 0 && keys.every((k) => this.seen.has(k));
    keys.forEach((k) => this.seen.set(k, now));
    return duplicate;
  }
  clear() {
    this.seen.clear();
  }
}
export function characterErrorRate(
  actual: string,
  expected: string,
): number | undefined {
  if (!expected.length) return undefined;
  const a = Array.from(actual),
    b = Array.from(expected);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(
        row[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = row;
  }
  return prev[b.length] / b.length;
}
export function summarize(attempts: Attempt[]) {
  const groups = new Map<
    string,
    {
      engine: string;
      source: string;
      resolution: string;
      roi: string;
      n: number;
      successes: number;
      duplicates: number;
      errors: number;
      exact: number;
      groundTruthN: number;
      cer: number[];
      ms: number[];
      inference: number[];
      init: number[];
      corrected: number;
      confirmed: number;
    }
  >();
  for (const a of attempts)
    for (const o of a.outputs.length
      ? a.outputs
      : [
          {
            engine: "capture",
            rawText: "",
            detections: [],
            initMs: 0,
            inferenceMs: 0,
          },
        ]) {
      const resolution = a.frameSize
        ? `${a.frameSize.width}×${a.frameSize.height}`
        : "n/a";
      const roi = a.roi
        ? `${a.roi.x},${a.roi.y},${a.roi.width},${a.roi.height}`
        : "full";
      const key = JSON.stringify([
        o.engine,
        a.source,
        a.cameraId,
        resolution,
        roi,
        a.transform,
      ]);
      const g = groups.get(key) ?? {
        engine: o.engine,
        source: a.source,
        resolution,
        roi,
        n: 0,
        successes: 0,
        duplicates: 0,
        errors: 0,
        exact: 0,
        groundTruthN: 0,
        cer: [],
        ms: [],
        inference: [],
        init: [],
        corrected: 0,
        confirmed: 0,
      };
      g.n++;
      g.successes += Number(o.detections.length > 0);
      g.duplicates += Number(a.isDuplicate);
      g.errors += Number(a.status === "error");
      if (a.source !== "wedge") {
        g.ms.push(a.timings.visibleMs ?? a.timings.totalMs);
        if (o.engine !== "capture") g.inference.push(o.inferenceMs);
      }
      g.init.push(o.initMs);
      g.corrected += Number(!!a.correction);
      g.confirmed += Number(a.confirmed);
      if (a.groundTruth) {
        g.groundTruthN++;
        g.exact += Number(o.rawText === a.groundTruth);
        const cer = characterErrorRate(o.rawText, a.groundTruth);
        if (cer !== undefined) g.cer.push(cer);
      }
      groups.set(key, g);
    }
  return [...groups.values()].map((g) => {
    const sorted = [...g.ms].sort((a, b) => a - b),
      inference = [...g.inference].sort((a, b) => a - b);
    return {
      ...g,
      ms: undefined,
      inference: undefined,
      init: undefined,
      maxInitMs: Math.max(...g.init),
      inferenceMedianMs:
        inference.length >= 5
          ? inference[Math.floor(inference.length / 2)]
          : undefined,
      inferenceP95Ms:
        inference.length >= 20
          ? inference[Math.ceil(inference.length * 0.95) - 1]
          : undefined,
      cer: g.cer.length
        ? g.cer.reduce((a, b) => a + b, 0) / g.cer.length
        : undefined,
      medianMs:
        sorted.length >= 5 ? sorted[Math.floor(sorted.length / 2)] : undefined,
      p95Ms:
        sorted.length >= 20
          ? sorted[Math.ceil(sorted.length * 0.95) - 1]
          : undefined,
    };
  });
}
function exportRuntime(runtime: unknown) {
  if (!runtime || typeof runtime !== "object") return undefined;
  const r = runtime as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of [
    "backend",
    "version",
    "ortVersion",
    "threads",
    "detProvider",
    "recProvider",
    "language",
  ])
    if (typeof r[key] === "string" || typeof r[key] === "number")
      out[key] = r[key];
  if (Array.isArray(r.downloads))
    out.downloads = r.downloads.flatMap((d: unknown) => {
      if (!d || typeof d !== "object") return [];
      const a = d as Record<string, unknown>;
      return typeof a.path === "string" &&
        a.path.startsWith("/scan-lab/vendor/") &&
        typeof a.bytes === "number" &&
        typeof a.downloadMs === "number"
        ? [{ path: a.path, bytes: a.bytes, downloadMs: a.downloadMs }]
        : [];
    });
  return out;
}
export function exportSession(attempts: Attempt[], includeText = false) {
  return {
    schema: "temcoscan-lab/v1",
    exportedAt: new Date().toISOString(),
    privacy: includeText
      ? "includes operator-approved text; no images"
      : "text, camera identifiers and images omitted",
    attempts: attempts.map((a) => ({
      ...a,
      cameraId: undefined,
      cameraSettings: a.cameraSettings
        ? {
            width: a.cameraSettings.width,
            height: a.cameraSettings.height,
            frameRate: a.cameraSettings.frameRate,
            facingMode: a.cameraSettings.facingMode,
          }
        : undefined,
      error: a.error ? "Recognition or camera error" : undefined,
      correction: includeText ? a.correction : undefined,
      groundTruth: includeText ? a.groundTruth : undefined,
      outputs: a.outputs.map((o) => ({
        ...o,
        runtime: exportRuntime(o.runtime),
        rawText: includeText ? o.rawText : undefined,
        detections: o.detections.map((d) => ({
          ...d,
          rawText: includeText ? d.rawText : undefined,
          normalizedText: includeText ? d.normalizedText : undefined,
        })),
      })),
    })),
    metrics: summarize(attempts),
  };
}
const csvCell = (v: unknown) => {
  const s = String(v ?? "");
  return `"${(/^[\s]*[=+\-@]/.test(s) ? "'" : "") + s.replace(/"/g, '""')}"`;
};
export function sessionCsv(attempts: Attempt[], includeText = false): string {
  const head = [
    "id",
    "timestamp",
    "frameId",
    "source",
    "task",
    "engine",
    "status",
    "duplicate",
    "confirmed",
    "totalMs",
    "initMs",
    "inferenceMs",
    "captureMs",
    "preprocessMs",
    "visibleMs",
    "frameSize",
    "roi",
    "transform",
    "rawText",
    "groundTruth",
    "correction",
  ];
  const rows = exportSession(attempts, includeText).attempts.flatMap((a) =>
    (a.outputs.length
      ? a.outputs
      : [{ engine: "capture", initMs: 0, inferenceMs: 0, rawText: "" }]
    ).map((o) => [
      a.id,
      a.timestamp,
      a.frameId,
      a.source,
      a.task,
      o.engine,
      a.status,
      a.isDuplicate,
      a.confirmed,
      a.source === "wedge" ? "" : a.timings.totalMs,
      a.source === "wedge" ? "" : o.initMs,
      a.source === "wedge" ? "" : o.inferenceMs,
      a.source === "wedge" ? "" : a.timings.captureMs,
      a.source === "wedge" ? "" : a.timings.preprocessMs,
      a.source === "wedge" ? "" : a.timings.visibleMs,
      JSON.stringify(a.frameSize),
      JSON.stringify(a.roi),
      JSON.stringify(a.transform),
      o.rawText,
      a.groundTruth,
      a.correction,
    ]),
  );
  return [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}
