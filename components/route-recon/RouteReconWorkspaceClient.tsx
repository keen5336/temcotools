"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

declare global {
  interface Window {
    bwipjs?: {
      toCanvas: (canvas: HTMLCanvasElement, options: Record<string, unknown>) => void;
    };
  }
}

const BARCODE_CDN_URL = "https://cdn.jsdelivr.net/npm/bwip-js@3.4.3/dist/bwip-js-min.js";
const ALL_ROUTES = "__all_routes__";
const NO_ROUTE_KEY = "__no_route__";

interface RouteReconItem {
  id: string;
  rowNumber: number;
  routeNumber: string | null;
  contact: string | null;
  orderNumber: string | null;
  lpn: string | null;
  serialNumber: string | null;
  trackingNumber: string | null;
  partNumber: string | null;
  description: string | null;
}

interface RouteReconDetail {
  id: string;
  name: string;
  sourceFilename: string;
  routeCount: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  createdBy: string | null;
  items: RouteReconItem[];
}

interface RouteGroup {
  key: string;
  routeNumber: string | null;
  items: RouteReconItem[];
}

export default function RouteReconWorkspaceClient({ initialReport }: { initialReport: RouteReconDetail }) {
  const groups = useMemo(() => groupItemsByRoute(initialReport.items), [initialReport.items]);
  const [selectedRouteKey, setSelectedRouteKey] = useState(groups[0]?.key ?? NO_ROUTE_KEY);
  const [printRouteKey, setPrintRouteKey] = useState(ALL_ROUTES);
  const [barcodeReady, setBarcodeReady] = useState(false);
  const [barcodeError, setBarcodeError] = useState<string | null>(null);
  const selectedGroup = groups.find((group) => group.key === selectedRouteKey) ?? groups[0];
  const hasBarcodes = initialReport.items.some((item) => Boolean(item.lpn));

  useEffect(() => {
    document.body.classList.add("route-recon-print-page");
    return () => document.body.classList.remove("route-recon-print-page");
  }, []);

  useEffect(() => {
    if (window.bwipjs) {
      const frame = window.requestAnimationFrame(() => setBarcodeReady(true));
      return () => window.cancelAnimationFrame(frame);
    }

    const existingScript = document.querySelector<HTMLScriptElement>(`script[src="${BARCODE_CDN_URL}"]`);
    const script = existingScript ?? document.createElement("script");
    const handleLoad = () => {
      setBarcodeReady(true);
      setBarcodeError(null);
    };
    const handleError = () => setBarcodeError("The barcode library could not be loaded. Check the network connection and try again.");
    script.addEventListener("load", handleLoad);
    script.addEventListener("error", handleError);
    if (!existingScript) {
      script.src = BARCODE_CDN_URL;
      script.async = true;
      document.head.appendChild(script);
    }
    return () => {
      script.removeEventListener("load", handleLoad);
      script.removeEventListener("error", handleError);
    };
  }, []);

  useEffect(() => {
    const resetPrintScope = () => setPrintRouteKey(ALL_ROUTES);
    window.addEventListener("afterprint", resetPrintScope);
    return () => window.removeEventListener("afterprint", resetPrintScope);
  }, []);

  function printRoutes(routeKey: string) {
    flushSync(() => setPrintRouteKey(routeKey));
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => window.print()));
  }

  const printingDisabled = hasBarcodes && !barcodeReady;

  return (
    <div className="route-recon-root">
      <div className="route-recon-screen-only space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <Link href="/tools/route-recon" className="link link-primary text-sm">← All Route Recons</Link>
            <div className="flex flex-wrap items-center gap-3 mt-2">
              <h1 className="text-2xl font-semibold">{initialReport.name}</h1>
              {initialReport.archivedAt ? <span className="badge badge-warning">Archived</span> : null}
            </div>
            <p className="text-sm text-base-content/60 mt-1">
              {initialReport.items.length} items across {groups.length} routes · {initialReport.sourceFilename}
            </p>
          </div>
          <button
            className="btn btn-primary btn-lg"
            onClick={() => printRoutes(ALL_ROUTES)}
            disabled={printingDisabled || !groups.length}
          >
            Print All Routes
          </button>
        </div>

        {barcodeError ? <div className="alert alert-error"><span>{barcodeError}</span></div> : null}
        {!barcodeReady && hasBarcodes && !barcodeError ? (
          <div className="alert"><span className="loading loading-spinner loading-sm" /><span>Preparing LPN barcodes…</span></div>
        ) : null}

        <section className="card bg-base-100 border border-base-200 shadow-sm">
          <div className="card-body">
            <div>
              <h2 className="card-title">Routes</h2>
              <p className="text-sm text-base-content/60 mt-1">Open a route to review its item list, or print it directly.</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 mt-2">
              {groups.map((group) => {
                const selected = group.key === selectedGroup?.key;
                return (
                  <div
                    key={group.key}
                    className={`rounded-xl border p-4 transition ${selected ? "border-primary bg-primary/5" : "border-base-200"}`}
                  >
                    <button className="w-full text-left" onClick={() => setSelectedRouteKey(group.key)}>
                      <span className="block text-xs font-bold uppercase tracking-wide text-base-content/55">Route</span>
                      <span className="block text-xl font-bold mt-1 break-words">{routeLabel(group.routeNumber)}</span>
                      <span className="block text-sm text-base-content/60 mt-1">{group.items.length} item{group.items.length === 1 ? "" : "s"}</span>
                    </button>
                    <div className="flex gap-2 mt-4">
                      <button className={`btn btn-sm flex-1 ${selected ? "btn-primary" : "btn-outline"}`} onClick={() => setSelectedRouteKey(group.key)}>
                        {selected ? "Open" : "View Items"}
                      </button>
                      <button className="btn btn-sm btn-outline" disabled={printingDisabled} onClick={() => printRoutes(group.key)}>
                        Print
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {selectedGroup ? (
          <section className="space-y-4" aria-labelledby="selected-route-heading">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-base-content/55">Route</p>
                <h2 id="selected-route-heading" className="text-2xl font-bold">{routeLabel(selectedGroup.routeNumber)}</h2>
                <p className="text-sm text-base-content/60">{selectedGroup.items.length} item{selectedGroup.items.length === 1 ? "" : "s"}</p>
              </div>
              <button className="btn btn-primary" disabled={printingDisabled} onClick={() => printRoutes(selectedGroup.key)}>
                Print This Route
              </button>
            </div>
            <div className="space-y-3">
              {selectedGroup.items.map((item) => (
                <RouteReconItemCard key={item.id} item={item} barcodeReady={barcodeReady} />
              ))}
            </div>
          </section>
        ) : null}
      </div>

      <div className="route-recon-print-only" aria-hidden="true">
        {groups.map((group, index) => {
          const excluded = printRouteKey !== ALL_ROUTES && printRouteKey !== group.key;
          const firstPrinted = index === 0 || printRouteKey === group.key;
          return (
            <section
              key={group.key}
              className={`route-recon-print-section ${excluded ? "route-recon-print-excluded" : ""} ${firstPrinted ? "route-recon-print-first" : ""}`}
            >
              <header className="route-recon-print-header">
                <div>
                  <p className="route-recon-print-kicker">Route Recon</p>
                  <h1>Route {routeLabel(group.routeNumber)}</h1>
                  <p>{initialReport.name} · {group.items.length} item{group.items.length === 1 ? "" : "s"}</p>
                </div>
                <div className="route-recon-print-meta">
                  <strong>Source</strong>
                  <span>{initialReport.sourceFilename}</span>
                  <strong>Created</strong>
                  <span>{formatDate(initialReport.createdAt)}</span>
                </div>
              </header>
              <div className="route-recon-print-items">
                {group.items.map((item) => (
                  <RouteReconItemCard key={item.id} item={item} barcodeReady={barcodeReady} print />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function RouteReconItemCard({ item, barcodeReady, print = false }: {
  item: RouteReconItem;
  barcodeReady: boolean;
  print?: boolean;
}) {
  const fields = [
    { label: "Route", value: item.routeNumber },
    { label: "Contact", value: item.contact },
    { label: "Order", value: item.orderNumber },
    { label: "LPN", value: item.lpn },
    { label: "Serial", value: item.serialNumber },
    { label: "Tracking", value: item.trackingNumber },
    { label: "Part", value: item.partNumber },
    { label: "Description", value: item.description, wide: true },
  ];

  return (
    <article className={`route-recon-item ${print ? "route-recon-item-print" : "bg-base-100 border-base-200 shadow-sm"}`}>
      <div className="route-recon-item-fields">
        {fields.map((field) => (
          <div key={field.label} className={field.wide ? "route-recon-field-wide" : ""}>
            <div className="route-recon-field-label">{field.label}</div>
            <div className="route-recon-field-value">{field.value || "—"}</div>
          </div>
        ))}
      </div>
      <div className="route-recon-barcode-area">
        <div className="route-recon-field-label">LPN Barcode</div>
        {item.lpn ? (
          barcodeReady ? <LpnBarcode value={item.lpn} /> : <div className="route-recon-barcode-placeholder">Preparing barcode…</div>
        ) : (
          <div className="route-recon-barcode-missing">No LPN</div>
        )}
      </div>
    </article>
  );
}

function LpnBarcode({ value }: { value: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canvasRef.current || !window.bwipjs) return;
    try {
      window.bwipjs.toCanvas(canvasRef.current, {
        bcid: "code128",
        text: value,
        scale: 3,
        height: 12,
        includetext: true,
        textxalign: "center",
        textsize: 10,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Barcode render error";
      window.requestAnimationFrame(() => setError(message));
    }
  }, [value]);

  if (error) return <div className="route-recon-barcode-missing">{error}</div>;
  return <canvas ref={canvasRef} className="route-recon-barcode" aria-label={`Code 128 barcode for LPN ${value}`} />;
}

function groupItemsByRoute(items: RouteReconItem[]): RouteGroup[] {
  const grouped = new Map<string, RouteGroup>();
  for (const item of items) {
    const routeNumber = item.routeNumber?.trim() || null;
    const key = routeNumber?.toLocaleLowerCase() ?? NO_ROUTE_KEY;
    const group = grouped.get(key) ?? { key, routeNumber, items: [] };
    group.items.push(item);
    grouped.set(key, group);
  }
  return [...grouped.values()].sort((a, b) => compareRoutes(a.routeNumber, b.routeNumber));
}

function compareRoutes(a: string | null, b: string | null) {
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b, undefined, { numeric: true });
}

function routeLabel(routeNumber: string | null) {
  return routeNumber || "No Route";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
