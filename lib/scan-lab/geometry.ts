import type { Point, Rect, Size } from "./types";
const clamp = (n: number, low: number, high: number) =>
  Math.max(low, Math.min(high, n));
export function clampRoi(r: Rect): Rect {
  const width = clamp(Number.isFinite(r.width) ? r.width : 1, 0.02, 1);
  const height = clamp(Number.isFinite(r.height) ? r.height : 1, 0.02, 1);
  return {
    x: clamp(Number.isFinite(r.x) ? r.x : 0, 0, 1 - width),
    y: clamp(Number.isFinite(r.y) ? r.y : 0, 0, 1 - height),
    width,
    height,
  };
}
export function fittedRect(
  source: Size,
  view: Size,
  fit: "contain" | "cover" = "contain",
): Rect {
  if (
    source.width <= 0 ||
    source.height <= 0 ||
    view.width <= 0 ||
    view.height <= 0
  )
    throw new Error("Invalid frame geometry");
  const scale = (fit === "contain" ? Math.min : Math.max)(
    view.width / source.width,
    view.height / source.height,
  );
  return {
    x: (view.width - source.width * scale) / 2,
    y: (view.height - source.height * scale) / 2,
    width: source.width * scale,
    height: source.height * scale,
  };
}
export function rotatedSize(s: Size, rotation: number): Size {
  return rotation % 180 ? { width: s.height, height: s.width } : s;
}
export function rotatePoint(
  p: Point,
  rotation: number,
  inverse = false,
): Point {
  const r = (((inverse ? -rotation : rotation) % 360) + 360) % 360;
  if (r === 90) return { x: 1 - p.y, y: p.x };
  if (r === 180) return { x: 1 - p.x, y: 1 - p.y };
  if (r === 270) return { x: p.y, y: 1 - p.x };
  return p;
}
/** Display rotation/mirroring are inverted before normalized source coordinates. Letterbox points are rejected. */
export function previewToSource(
  p: Point,
  source: Size,
  view: Size,
  mirror = false,
  rotation = 0,
  fit: "contain" | "cover" = "contain",
): Point | null {
  const box = fittedRect(rotatedSize(source, rotation), view, fit);
  const q = { x: (p.x - box.x) / box.width, y: (p.y - box.y) / box.height };
  if (q.x < 0 || q.x > 1 || q.y < 0 || q.y > 1) return null;
  if (mirror) q.x = 1 - q.x;
  return rotatePoint(q, rotation, true);
}
export function sourceRoiToPreview(
  roi: Rect,
  source: Size,
  view: Size,
  mirror = false,
  rotation = 0,
): Rect {
  const box = fittedRect(rotatedSize(source, rotation), view);
  const points = [
    rotatePoint({ x: roi.x, y: roi.y }, rotation),
    rotatePoint({ x: roi.x + roi.width, y: roi.y + roi.height }, rotation),
  ];
  if (mirror)
    points.forEach((p) => {
      p.x = 1 - p.x;
    });
  return {
    x: box.x + Math.min(...points.map((p) => p.x)) * box.width,
    y: box.y + Math.min(...points.map((p) => p.y)) * box.height,
    width: Math.abs(points[1].x - points[0].x) * box.width,
    height: Math.abs(points[1].y - points[0].y) * box.height,
  };
}
export function pixelCrop(roi: Rect, size: Size): Rect {
  const r = clampRoi(roi);
  const x = Math.floor(r.x * size.width),
    y = Math.floor(r.y * size.height);
  return {
    x,
    y,
    width: Math.max(
      1,
      Math.min(size.width - x, Math.ceil(r.width * size.width)),
    ),
    height: Math.max(
      1,
      Math.min(size.height - y, Math.ceil(r.height * size.height)),
    ),
  };
}
