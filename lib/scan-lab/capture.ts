import { pixelCrop } from "./geometry";
import type { Rect, Size, Transform } from "./types";
function canvas(width: number, height: number) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}
export function canvasBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Frame encoding failed"))),
      "image/png",
    ),
  );
}
export async function imageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  if (blob.size > 20 * 1024 * 1024)
    throw new Error("Image exceeds 20 MiB limit");
  if (!["image/png", "image/jpeg", "image/webp"].includes(blob.type))
    throw new Error("Use PNG, JPEG or WebP images");
  const url = URL.createObjectURL(blob),
    image = new Image();
  try {
    image.src = url;
    await image.decode();
    if (image.naturalWidth * image.naturalHeight > 12_000_000)
      throw new Error("Image exceeds 12 megapixels");
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}
export function captureOriginal(
  source: HTMLVideoElement | HTMLImageElement,
): HTMLCanvasElement {
  const width =
    source instanceof HTMLVideoElement
      ? source.videoWidth
      : source.naturalWidth;
  const height =
    source instanceof HTMLVideoElement
      ? source.videoHeight
      : source.naturalHeight;
  if (!width || !height) throw new Error("Frame is not ready yet");
  if (width * height > 12_000_000)
    throw new Error(
      "Frame exceeds 12 megapixels; choose a smaller camera resolution",
    );
  const c = canvas(width, height),
    ctx = c.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable");
  ctx.drawImage(source, 0, 0);
  return c;
}
/** ROI is applied to the unmodified source BEFORE resize, photometric transforms and clockwise rotation. */
export function preprocess(
  source: HTMLCanvasElement,
  roi: Rect | undefined,
  t: Transform,
): HTMLCanvasElement {
  const crop = roi
    ? pixelCrop(roi, source)
    : { x: 0, y: 0, width: source.width, height: source.height };
  const scale = Math.min(1, t.maxEdge / Math.max(crop.width, crop.height));
  const w = Math.max(1, Math.round(crop.width * scale)),
    h = Math.max(1, Math.round(crop.height * scale));
  const c = canvas(t.rotation % 180 ? h : w, t.rotation % 180 ? w : h),
    ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas is unavailable");
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((t.rotation * Math.PI) / 180);
  ctx.drawImage(
    source,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    -w / 2,
    -h / 2,
    w,
    h,
  );
  if (t.grayscale || t.threshold || t.contrast !== 1) {
    const d = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < d.data.length; i += 4) {
      const v =
        0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2];
      for (let j = 0; j < 3; j++) {
        let n = t.grayscale || t.threshold ? v : d.data[i + j];
        n = (n - 128) * t.contrast + 128;
        d.data[i + j] = t.threshold ? (n > 128 ? 255 : 0) : n;
      }
    }
    ctx.putImageData(d, 0, 0);
  }
  return c;
}
export async function frameHash(c: HTMLCanvasElement): Promise<string> {
  const bytes = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return (
    `${c.width}x${c.height}:` +
    [...new Uint8Array(hash)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}
export function sizeOf(image: HTMLImageElement | HTMLVideoElement): Size {
  return image instanceof HTMLVideoElement
    ? { width: image.videoWidth, height: image.videoHeight }
    : { width: image.naturalWidth, height: image.naturalHeight };
}
