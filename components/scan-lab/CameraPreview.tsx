"use client";
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  clampRoi,
  fittedRect,
  previewToSource,
  sourceRoiToPreview,
} from "../../lib/scan-lab/geometry";
import type { Rect, Size } from "../../lib/scan-lab/types";
import styles from "./scan-lab.module.css";
interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
  stillUrl?: string;
  sourceSize: Size;
  mirror: boolean;
  roi?: Rect;
  onRoi: (roi: Rect) => void;
  docked?: boolean;
}
export default function CameraPreview({
  videoRef,
  stillUrl,
  sourceSize,
  mirror,
  roi,
  onRoi,
  docked = false,
}: Props) {
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    x: number;
    y: number;
    roi: Rect;
    resize: boolean;
  } | null>(null);
  const [view, setView] = useState({ width: 320, height: 220 });
  const [expanded, setExpanded] = useState(false),
    [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (!stage.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setView({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, []);
  const size = sourceSize.width ? sourceSize : { width: 16, height: 9 };
  const overlay = roi ? sourceRoiToPreview(roi, size, view, mirror) : undefined;
  return (
    <div>
      <div className={styles.row}>
        <strong>{docked ? "Live preview" : "Inline preview"}</strong>
        <button type="button" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Compact" : "Expand"}
        </button>
        <button type="button" onClick={() => setCollapsed((v) => !v)}>
          {collapsed ? "Show preview" : "Collapse preview"}
        </button>
      </div>
      <div
        ref={stage}
        data-testid="camera-stage"
        className={styles.preview}
        style={{ height: docked ? collapsed ? "min(64px, 18dvh)" : expanded ? "min(240px, 36dvh)" : "min(180px, 28dvh)" : collapsed ? 36 : expanded ? 390 : 220 }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const fit = fittedRect(size, view),
            d = drag.current;
          const dx = ((e.clientX - d.x) / fit.width) * (mirror ? -1 : 1),
            dy = (e.clientY - d.y) / fit.height;
          onRoi(
            clampRoi(
              d.resize
                ? {
                    x: mirror ? d.roi.x + dx : d.roi.x,
                    y: d.roi.y,
                    width: d.roi.width + (mirror ? -dx : dx),
                    height: d.roi.height + dy,
                  }
                : { ...d.roi, x: d.roi.x + dx, y: d.roi.y + dy },
            ),
          );
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          aria-label="Live camera preview"
          style={{
            transform: mirror ? "scaleX(-1)" : undefined,
            visibility: stillUrl ? "hidden" : "visible",
          }}
        />
        {/* The uploaded/replay URL is created locally; Next image optimization would send it to the server. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {stillUrl && <img src={stillUrl} alt="Local replay frame" />}
        {!collapsed && overlay && (
          <div
            data-testid="roi"
            aria-label="Region of interest; drag to move"
            className={styles.roi}
            style={{
              left: overlay.x,
              top: overlay.y,
              width: overlay.width,
              height: overlay.height,
            }}
            onPointerDown={(e) => {
              if (!roi || !stage.current) return;
              const bounds = stage.current.getBoundingClientRect();
              if (
                !previewToSource(
                  { x: e.clientX - bounds.left, y: e.clientY - bounds.top },
                  size,
                  view,
                  mirror,
                )
              )
                return;
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = {
                x: e.clientX,
                y: e.clientY,
                roi,
                resize: (e.target as HTMLElement).dataset.resize === "true",
              };
            }}
          >
            <span>ROI</span>
            <span
              data-resize="true"
              aria-hidden="true"
              className={styles.resize}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export function RoiInputs({ roi, onRoi }: { roi: Rect; onRoi: (roi: Rect) => void }) {
  return <div className={styles.roiInputs}>
          {(["x", "y", "width", "height"] as const).map((k) => (
            <label key={k}>
              {k} %
              <input
                aria-label={`ROI ${k} percent`}
                type="number"
                min={0}
                max={100}
                step={1}
                value={Math.round(roi[k] * 100)}
                onChange={(e) =>
                  onRoi(clampRoi({ ...roi, [k]: Number(e.target.value) / 100 }))
                }
              />
            </label>
          ))}
        </div>;
}
