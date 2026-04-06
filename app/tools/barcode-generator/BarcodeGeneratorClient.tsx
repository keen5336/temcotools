"use client";

import { useState, useEffect, useRef, useCallback } from "react";

declare global {
  interface Window {
    bwipjs?: {
      toCanvas: (
        canvas: HTMLCanvasElement,
        options: Record<string, unknown>
      ) => void;
    };
  }
}

const CDN_URL =
  "https://cdn.jsdelivr.net/npm/bwip-js@3.4.3/dist/bwip-js-min.js";

function BarcodeCard({ value }: { value: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canvasRef.current || !window.bwipjs) return;
    try {
      setError(null);
      window.bwipjs.toCanvas(canvasRef.current, {
        bcid: "code128",
        text: value,
        scale: 3,
        height: 12,
        includetext: true,
        textxalign: "center",
        textsize: 10,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Render error");
    }
  }, [value]);

  return (
    <div className="card bg-base-100 border border-base-200 shadow-sm flex flex-col items-center p-4 gap-2">
      <p className="text-xs font-mono text-base-content/60 truncate w-full text-center">
        {value}
      </p>
      {error ? (
        <div className="text-xs text-error text-center px-2">{error}</div>
      ) : (
        <div className="bg-white p-2 rounded">
          <canvas ref={canvasRef} className="max-w-full" />
        </div>
      )}
    </div>
  );
}

export default function BarcodeGeneratorClient() {
  const [isLoaded, setIsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [input, setInput] = useState("");

  useEffect(() => {
    if (window.bwipjs) {
      setIsLoaded(true);
      return;
    }
    const script = document.createElement("script");
    script.src = CDN_URL;
    script.async = true;
    script.onload = () => setIsLoaded(true);
    script.onerror = () =>
      setLoadError(
        `Failed to load barcode library from ${CDN_URL}. Please check your internet connection.`
      );
    document.head.appendChild(script);
  }, []);

  const lines = input
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const handlePrint = useCallback(() => {
    window.print();
  }, []);

  return (
    <div className="flex flex-col lg:flex-row gap-6 items-start">
      {/* Sidebar */}
      <aside className="w-full lg:w-72 shrink-0 sticky top-4">
        <div className="card bg-base-100 border border-base-200 shadow-sm">
          <div className="card-body gap-4">
            <div>
              <h2 className="card-title text-base">Input</h2>
              <p className="text-sm text-base-content/60 mt-1">
                Paste barcodes, one per line.
              </p>
            </div>
            <textarea
              className="textarea textarea-bordered font-mono min-h-64 resize-y w-full"
              placeholder={"ABC-001\nABC-002\nABC-003"}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              autoFocus
            />
            <div className="flex gap-2">
              <button
                className="btn btn-sm btn-ghost flex-1"
                onClick={() => setInput("")}
                disabled={!input}
              >
                Clear
              </button>
              <button
                className="btn btn-sm btn-primary flex-1"
                onClick={handlePrint}
                disabled={lines.length === 0}
              >
                Print
              </button>
            </div>
            {lines.length > 0 && (
              <p className="text-xs text-base-content/50 text-center">
                {lines.length} barcode{lines.length !== 1 ? "s" : ""}
              </p>
            )}
          </div>
        </div>
      </aside>

      {/* Main grid */}
      <div className="flex-1 min-w-0">
        {loadError ? (
          <div className="flex items-center justify-center h-48 text-error text-sm text-center px-4">
            {loadError}
          </div>
        ) : !isLoaded ? (
          <div className="flex items-center justify-center h-48 text-base-content/50 text-sm">
            Loading barcode library…
          </div>
        ) : lines.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-base-content/40 text-sm border border-dashed border-base-300 rounded-xl">
            Barcodes will appear here
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {lines.map((val, idx) => (
              <BarcodeCard key={`${val}-${idx}`} value={val} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
