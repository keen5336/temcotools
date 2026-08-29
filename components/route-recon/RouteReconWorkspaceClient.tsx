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
const SEARCHABLE_FIELDS: Array<keyof Pick<RouteReconItem,
  "serialNumber" | "contact" | "trackingNumber" | "orderNumber" | "partNumber" | "lpn" | "description"
>> = ["serialNumber", "contact", "trackingNumber", "orderNumber", "partNumber", "lpn", "description"];

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
  const [selectedRouteKey, setSelectedRouteKey] = useState(ALL_ROUTES);
  const [search, setSearch] = useState("");
  const [printRouteKey, setPrintRouteKey] = useState(ALL_ROUTES);
  const [barcodeReady, setBarcodeReady] = useState(false);
  const [barcodeError, setBarcodeError] = useState<string | null>(null);
  const selectedGroup = groups.find((group) => group.key === selectedRouteKey);
  const selectedItems = selectedRouteKey === ALL_ROUTES ? initialReport.items : selectedGroup?.items ?? [];
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleItems = normalizedSearch
    ? selectedItems.filter((item) => SEARCHABLE_FIELDS.some((field) => item[field]?.toLocaleLowerCase().includes(normalizedSearch)))
    : selectedItems;
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

        {barcodeError ? <div className="alert alert-error"><span>{barcodeError}</span></div> : null}
        {!barcodeReady && hasBarcodes && !barcodeError ? (
          <div className="alert"><span className="loading loading-spinner loading-sm" /><span>Preparing LPN barcodes…</span></div>
        ) : null}

        <section className="card bg-base-100 border border-base-200 shadow-sm">
          <div className="card-body p-4">
            <div className="flex flex-nowrap gap-3 items-center">
              <label className="form-control w-44 sm:w-64 shrink-0">
                <span className="sr-only">Route</span>
                <select
                  className="select select-bordered w-full"
                  value={selectedRouteKey}
                  onChange={(event) => setSelectedRouteKey(event.target.value)}
                >
                  <option value={ALL_ROUTES}>All Routes ({initialReport.items.length})</option>
                  {groups.map((group) => (
                    <option key={group.key} value={group.key}>
                      {routeLabel(group.routeNumber)} ({group.items.length})
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-control flex-1 min-w-0">
                <span className="sr-only">Search items</span>
                <input
                  className="input input-bordered w-full"
                  type="text"
                  placeholder="Search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <button className="btn btn-outline shrink-0" disabled={!search} onClick={() => setSearch("")}>
                Clear
              </button>
            </div>
          </div>
        </section>

        <section className="space-y-4" aria-labelledby="selected-route-heading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              {selectedRouteKey !== ALL_ROUTES ? <p className="text-xs font-bold uppercase tracking-wide text-base-content/55">Route</p> : null}
              <h2 id="selected-route-heading" className="text-2xl font-bold">
                {selectedRouteKey === ALL_ROUTES ? "All Routes" : routeLabel(selectedGroup?.routeNumber ?? null)}
              </h2>
              <p className="text-sm text-base-content/60">
                {normalizedSearch ? `${visibleItems.length} of ${selectedItems.length}` : selectedItems.length} item{visibleItems.length === 1 ? "" : "s"}
              </p>
            </div>
            <button
              className="btn btn-primary"
              disabled={printingDisabled || !selectedItems.length}
              onClick={() => printRoutes(selectedRouteKey)}
            >
              {selectedRouteKey === ALL_ROUTES ? "Print All Routes" : "Print This Route"}
            </button>
          </div>
          {visibleItems.length ? (
            <div className="space-y-3">
              {visibleItems.map((item) => (
                <RouteReconItemCard
                  key={item.id}
                  item={item}
                  barcodeReady={barcodeReady}
                  highlightQuery={search.trim()}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-base-300 bg-base-100 py-12 px-4 text-center text-base-content/60">
              No items match “{search.trim()}”.
            </div>
          )}
        </section>
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

function RouteReconItemCard({ item, barcodeReady, print = false, highlightQuery = "" }: {
  item: RouteReconItem;
  barcodeReady: boolean;
  print?: boolean;
  highlightQuery?: string;
}) {
  const fields = [
    { label: "Route", value: item.routeNumber, searchable: false },
    { label: "Contact", value: item.contact, searchable: true },
    { label: "Order", value: item.orderNumber, searchable: true },
    { label: "LPN", value: item.lpn, searchable: true },
    { label: "Serial", value: item.serialNumber, searchable: true },
    { label: "Tracking", value: item.trackingNumber, searchable: true },
    { label: "Part", value: item.partNumber, searchable: true },
    { label: "Description", value: item.description, searchable: true, wide: true },
  ];

  return (
    <article className={`route-recon-item ${print ? "route-recon-item-print" : "bg-base-100 border-base-200 shadow-sm"}`}>
      <div className="route-recon-item-fields">
        {fields.map((field) => (
          <div key={field.label} className={field.wide ? "route-recon-field-wide" : ""}>
            <div className="route-recon-field-label">{field.label}</div>
            <div className="route-recon-field-value">
              {field.value ? highlightMatches(field.value, field.searchable ? highlightQuery : "") : "—"}
            </div>
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

function highlightMatches(value: string, query: string) {
  const normalizedQuery = query.toLocaleLowerCase();
  if (!normalizedQuery) return value;

  const normalizedValue = value.toLocaleLowerCase();
  const parts = [];
  let cursor = 0;
  let matchStart = normalizedValue.indexOf(normalizedQuery, cursor);

  while (matchStart !== -1) {
    if (matchStart > cursor) parts.push(value.slice(cursor, matchStart));
    const matchEnd = matchStart + query.length;
    parts.push(
      <mark key={matchStart} className="rounded-sm bg-warning/60 text-base-content px-0.5 font-extrabold">
        {value.slice(matchStart, matchEnd)}
      </mark>,
    );
    cursor = matchEnd;
    matchStart = normalizedValue.indexOf(normalizedQuery, cursor);
  }

  if (!parts.length) return value;
  if (cursor < value.length) parts.push(value.slice(cursor));
  return parts;
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
