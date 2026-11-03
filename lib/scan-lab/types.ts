export type Task = "barcode" | "ocr" | "hybrid";
export type OcrEngine = "tesseract" | "paddle";
export type BarcodeEngine = "auto" | "native" | "zxing";
export type Source = "camera" | "upload" | "replay" | "wedge";
export interface Size {
  width: number;
  height: number;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}
export interface Detection {
  kind: "barcode" | "ocr";
  rawText: string;
  normalizedText: string;
  symbology?: string;
  confidence?: number;
  confidenceScale?: "0-100" | "0-1";
  boundingBox?: Rect;
  points?: Point[];
}
export interface EngineOutput {
  engine: string;
  detections: Detection[];
  rawText: string;
  initMs: number;
  inferenceMs: number;
  runtime?: unknown;
}
export interface Transform {
  rotation: 0 | 90 | 180 | 270;
  grayscale: boolean;
  threshold: boolean;
  contrast: number;
  maxEdge: number;
}
export interface Attempt {
  id: string;
  timestamp: string;
  frameId?: string;
  source: Source;
  task: Task;
  cameraId?: string;
  cameraSettings?: MediaTrackSettings;
  cameraStartupMs?: number;
  requestedResolution?: string;
  frameSize?: Size;
  processedSize?: Size;
  roi?: Rect;
  transform?: Transform;
  outputs: EngineOutput[];
  status: "success" | "miss" | "error";
  error?: string;
  isDuplicate: boolean;
  confirmed: boolean;
  correction?: string;
  groundTruth?: string;
  timings: {
    measured?: boolean;
    captureMs: number;
    preprocessMs: number;
    totalMs: number;
    visibleMs?: number;
  };
}
export interface Progress {
  engine: string;
  status: string;
  progress?: number;
}
export const DEFAULT_ROI: Rect = { x: 0.1, y: 0.25, width: 0.8, height: 0.5 };
export const DEFAULT_TRANSFORM: Transform = {
  rotation: 0,
  grayscale: false,
  threshold: false,
  contrast: 1,
  maxEdge: 1600,
};
