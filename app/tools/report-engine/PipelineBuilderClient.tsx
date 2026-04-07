"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import {
  executePipeline,
  type Step,
  type FilterOperator,
} from "@/lib/pipeline/executePipeline";
import PreviewTable from "@/components/PreviewTable";

declare global {
  interface Window {
    XLSX: any;
  }
}

const XLSX_CDN_URL =
  "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";

// ── Types ─────────────────────────────────────────────────────────────────────

type StepWithId = Step & { id: string };

// ── Spreadsheet / CSV Helpers ─────────────────────────────────────────────────

/**
 * Minimal CSV parser used for .csv file uploads and the join-step paste area.
 * ExcelJS CSV support requires a Node.js Readable stream, so we handle plain
 * text CSV inline.
 */
function parseCSV(text: string): Record<string, unknown>[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const parseRow = (line: string): string[] => {
    const result: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        result.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    result.push(cur);
    return result;
  };
  const headers = parseRow(lines[0]).map((h) => h.trim());
  if (headers.length === 0) return [];
  return lines
    .slice(1)
    .filter((l) => l.trim() !== "")
    .map((line) => {
      const values = parseRow(line);
      return Object.fromEntries(
        headers.map((h, i) => [h, (values[i] ?? "").trim()])
      );
    });
}

/**
 * Parse a binary xlsx/xls ArrayBuffer using window.XLSX (loaded via CDN).
 * Logs a warning when the workbook has multiple sheets and uses the first one.
 */
function parseWorkbook(buffer: ArrayBuffer): Record<string, unknown>[] {
  const workbook = window.XLSX.read(new Uint8Array(buffer), { type: "array" });
  if (!workbook) throw new Error("Failed to parse Excel file");

  if (workbook.SheetNames.length > 1) {
    console.warn(
      `Workbook has ${workbook.SheetNames.length} sheets. Using the first sheet: "${workbook.SheetNames[0]}".`
    );
  }

  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];
  return window.XLSX.utils.sheet_to_json(worksheet) as Record<
    string,
    unknown
  >[];
}

function exportXLSX(
  data: Record<string, unknown>[],
  filename = "report-export.xlsx"
): void {
  if (data.length === 0) return;
  const wb = window.XLSX.utils.book_new();
  const ws = window.XLSX.utils.json_to_sheet(data);
  window.XLSX.utils.book_append_sheet(wb, ws, "Report");
  const wbout: ArrayBuffer = window.XLSX.write(wb, {
    bookType: "xlsx",
    type: "array",
  });
  const blob = new Blob([wbout], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function CheckCircleIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className={className ?? "h-5 w-5"}
    >
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function DotCircleIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className={className ?? "h-5 w-5"}
    >
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16z"
        clipRule="evenodd"
      />
    </svg>
  );
}

// ── Constants ─────────────────────────────────────────────────────────────────

const FILTER_OPERATORS: { value: FilterOperator; label: string }[] = [
  { value: "eq", label: "equals" },
  { value: "neq", label: "not equals" },
  { value: "contains", label: "contains" },
  { value: "notcontains", label: "not contains" },
  { value: "isempty", label: "is empty" },
  { value: "notempty", label: "is not empty" },
  { value: "gt", label: "greater than" },
  { value: "lt", label: "less than" },
  { value: "gte", label: "≥ (gte)" },
  { value: "lte", label: "≤ (lte)" },
];

const VALUE_LESS_OPS: FilterOperator[] = ["isempty", "notempty"];

// ── Component ─────────────────────────────────────────────────────────────────

export default function PipelineBuilderClient() {
  // ─ Library state
  const [xlsxLoaded, setXlsxLoaded] = useState(false);
  const [xlsxLoadError, setXlsxLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (window.XLSX) {
      setXlsxLoaded(true);
      return;
    }
    const script = document.createElement("script");
    script.src = XLSX_CDN_URL;
    script.async = true;
    script.onload = () => setXlsxLoaded(true);
    script.onerror = () =>
      setXlsxLoadError(
        `Failed to load spreadsheet library from ${XLSX_CDN_URL}. Please check your internet connection.`
      );
    document.head.appendChild(script);
  }, []);

  // ─ Data state
  const [rawData, setRawData] = useState<Record<string, unknown>[]>([]);
  const [fileName, setFileName] = useState<string>("");
  const [steps, setSteps] = useState<StepWithId[]>([]);
  const [fileError, setFileError] = useState<string>("");
  const [exportError, setExportError] = useState<string>("");

  // ─ New-step form state
  const [showNewStep, setShowNewStep] = useState(false);
  const [newStepType, setNewStepType] = useState<Step["type"]>("filter");

  const [filterCol, setFilterCol] = useState("");
  const [filterOp, setFilterOp] = useState<FilterOperator>("eq");
  const [filterVal, setFilterVal] = useState("");

  const [sortCol, setSortCol] = useState("");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const [mapFrom, setMapFrom] = useState("");
  const [mapTo, setMapTo] = useState("");

  const [joinCsv, setJoinCsv] = useState("");
  const [joinOn, setJoinOn] = useState("");
  const [joinPrefix, setJoinPrefix] = useState("r_");

  const fileInputRef = useRef<HTMLInputElement>(null);

  const columns = useMemo(
    () => (rawData.length > 0 ? Object.keys(rawData[0]) : []),
    [rawData]
  );

  const previewData = useMemo(
    () => executePipeline(rawData, steps as Step[]),
    [rawData, steps]
  );

  // ─ Handlers

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setFileError("");
    const isCsv = file.name.toLowerCase().endsWith(".csv");
    const reader = new FileReader();
    if (isCsv) {
      reader.onload = (ev) => {
        const text = ev.target?.result as string;
        const parsed = parseCSV(text);
        setRawData(parsed);
        setSteps([]);
        setShowNewStep(false);
      };
      reader.readAsText(file);
    } else {
      reader.onload = (ev) => {
        try {
          const buffer = ev.target?.result as ArrayBuffer;
          const parsed = parseWorkbook(buffer);
          setRawData(parsed);
          setSteps([]);
          setShowNewStep(false);
        } catch (err) {
          setFileError(
            err instanceof Error
              ? err.message
              : "Failed to parse file. Make sure it is a valid .xlsx or .xls workbook."
          );
        }
      };
      reader.readAsArrayBuffer(file);
    }
  }

  function resetNewStepForm(cols: string[]) {
    const first = cols[0] ?? "";
    setFilterCol(first);
    setFilterOp("eq");
    setFilterVal("");
    setSortCol(first);
    setSortDir("asc");
    setMapFrom(first);
    setMapTo("");
    setJoinCsv("");
    setJoinOn(first);
    setJoinPrefix("r_");
  }

  function handleAddStep() {
    if (!isNewStepValid()) return;
    let step: Step;
    switch (newStepType) {
      case "filter":
        step = {
          type: "filter",
          column: filterCol,
          operator: filterOp,
          value: filterVal,
        };
        break;
      case "sort":
        step = { type: "sort", column: sortCol, direction: sortDir };
        break;
      case "map":
        step = { type: "map", from: mapFrom, to: mapTo.trim() || null };
        break;
      case "join": {
        const parsed = parseCSV(joinCsv);
        step = {
          type: "join",
          rightData: parsed,
          on: joinOn,
          prefix: joinPrefix || "r_",
        };
        break;
      }
    }
    setSteps((prev) => [...prev, { ...step, id: crypto.randomUUID() }]);
    setShowNewStep(false);
  }

  function isNewStepValid(): boolean {
    switch (newStepType) {
      case "filter":
        return !!filterCol;
      case "sort":
        return !!sortCol;
      case "map":
        return !!mapFrom;
      case "join":
        return !!joinOn && joinCsv.trim() !== "";
      default:
        return false;
    }
  }

  function removeStep(id: string) {
    setSteps((prev) => prev.filter((s) => s.id !== id));
  }

  function describeStep(step: StepWithId): string {
    switch (step.type) {
      case "filter":
        return `Filter: "${step.column}" ${step.operator}${
          !VALUE_LESS_OPS.includes(step.operator) ? ` "${step.value}"` : ""
        }`;
      case "sort":
        return `Sort: "${step.column}" ${step.direction.toUpperCase()}`;
      case "map":
        return step.to
          ? `Rename: "${step.from}" → "${step.to}"`
          : `Drop column: "${step.from}"`;
      case "join":
        return `Join on: "${step.on}" (prefix: "${step.prefix}")`;
    }
  }

  const hasData = rawData.length > 0;
  const uploadDone = hasData;
  const transformDone = steps.length > 0;
  const previewDone = previewData.length > 0;

  return (
    <>
      {/* ── Screen view (hidden during print) ── */}
      <div className="print:hidden">
        {xlsxLoadError && (
          <div className="alert alert-error mb-4 text-sm">{xlsxLoadError}</div>
        )}
        {!xlsxLoaded && !xlsxLoadError && (
          <div className="flex items-center gap-2 text-sm text-base-content/50 mb-4">
            <span className="loading loading-spinner loading-xs" />
            Loading spreadsheet library…
          </div>
        )}
        <ul className="timeline timeline-vertical w-full">
          {/* ─────────────────── Step 1: Upload ─────────────────── */}
          <li>
            <div className="timeline-middle">
              {uploadDone ? (
                <CheckCircleIcon className="h-5 w-5 text-success" />
              ) : (
                <DotCircleIcon className="h-5 w-5 text-base-content/30" />
              )}
            </div>
            <div className="timeline-end timeline-box mb-6 w-full max-w-none">
              <h3 className="text-sm font-semibold mb-2 text-base-content">
                1 · Upload
              </h3>
              <p className="text-xs text-base-content/60 mb-3">
                Upload a spreadsheet (.xlsx, .xls) or CSV file to start the pipeline.
              </p>
              <div className="flex items-center gap-3 flex-wrap">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="file-input file-input-sm file-input-bordered"
                  onChange={handleFile}
                  disabled={!xlsxLoaded}
                />
              </div>
              {hasData && (
                <>
                  <p className="text-xs text-success mt-2">
                    ✓ Loaded <strong>{rawData.length}</strong> rows ·{" "}
                    <strong>{columns.length}</strong> columns from{" "}
                    <em>{fileName}</em>
                  </p>
                  <div className="mt-3">
                    <p className="text-xs text-base-content/50 mb-1">
                      Preview (first 5 rows):
                    </p>
                    <PreviewTable data={rawData.slice(0, 5)} />
                  </div>
                </>
              )}
              {fileError && (
                <p className="text-xs text-error mt-2">✕ {fileError}</p>
              )}
            </div>
            <hr />
          </li>

          {/* ─────────────────── Step 2: Transform ─────────────────── */}
          <li>
            <hr />
            <div className="timeline-middle">
              {transformDone ? (
                <CheckCircleIcon className="h-5 w-5 text-success" />
              ) : (
                <DotCircleIcon
                  className={`h-5 w-5 ${
                    hasData ? "text-primary" : "text-base-content/30"
                  }`}
                />
              )}
            </div>
            <div className="timeline-end timeline-box mb-6 w-full max-w-none">
              <h3 className="text-sm font-semibold mb-2 text-base-content">
                2 · Transform
              </h3>

              {!hasData ? (
                <p className="text-xs text-base-content/40">
                  Upload data first.
                </p>
              ) : (
                <>
                  {steps.length === 0 && !showNewStep && (
                    <p className="text-xs text-base-content/50 mb-3">
                      No transforms applied — data passes through unchanged.
                    </p>
                  )}

                  {/* Applied steps list */}
                  {steps.length > 0 && (
                    <ul className="space-y-1 mb-3">
                      {steps.map((s, i) => (
                        <li
                          key={s.id}
                          className="flex items-center gap-2 bg-base-200 rounded px-3 py-1.5 text-xs"
                        >
                          <span className="text-base-content/50 font-mono w-4 shrink-0">
                            {i + 1}.
                          </span>
                          <span className="flex-1 truncate text-base-content">
                            {describeStep(s)}
                          </span>
                          <button
                            onClick={() => removeStep(s.id)}
                            className="btn btn-ghost btn-xs text-error shrink-0"
                            aria-label="Remove step"
                          >
                            ✕
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* Add step button or inline form */}
                  {!showNewStep ? (
                    <button
                      onClick={() => {
                        resetNewStepForm(columns);
                        setShowNewStep(true);
                      }}
                      className="btn btn-sm btn-outline"
                    >
                      + Add step
                    </button>
                  ) : (
                    <div className="border border-base-300 rounded-lg p-4 bg-base-100 space-y-3">
                      {/* Step type tabs */}
                      <div className="flex gap-2 flex-wrap">
                        {(["filter", "sort", "map", "join"] as const).map(
                          (t) => (
                            <button
                              key={t}
                              onClick={() => setNewStepType(t)}
                              className={`btn btn-xs capitalize ${
                                newStepType === t
                                  ? "btn-primary"
                                  : "btn-outline"
                              }`}
                            >
                              {t}
                            </button>
                          )
                        )}
                      </div>

                      {/* Filter form */}
                      {newStepType === "filter" && (
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                          <select
                            className="select select-sm select-bordered"
                            value={filterCol}
                            onChange={(e) => setFilterCol(e.target.value)}
                          >
                            {columns.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                          <select
                            className="select select-sm select-bordered"
                            value={filterOp}
                            onChange={(e) =>
                              setFilterOp(e.target.value as FilterOperator)
                            }
                          >
                            {FILTER_OPERATORS.map((op) => (
                              <option key={op.value} value={op.value}>
                                {op.label}
                              </option>
                            ))}
                          </select>
                          {!VALUE_LESS_OPS.includes(filterOp) && (
                            <input
                              type="text"
                              className="input input-sm input-bordered"
                              placeholder="value"
                              value={filterVal}
                              onChange={(e) => setFilterVal(e.target.value)}
                            />
                          )}
                        </div>
                      )}

                      {/* Sort form */}
                      {newStepType === "sort" && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <select
                            className="select select-sm select-bordered"
                            value={sortCol}
                            onChange={(e) => setSortCol(e.target.value)}
                          >
                            {columns.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                          <select
                            className="select select-sm select-bordered"
                            value={sortDir}
                            onChange={(e) =>
                              setSortDir(e.target.value as "asc" | "desc")
                            }
                          >
                            <option value="asc">Ascending</option>
                            <option value="desc">Descending</option>
                          </select>
                        </div>
                      )}

                      {/* Map form */}
                      {newStepType === "map" && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <div>
                            <label className="label py-0.5">
                              <span className="label-text text-xs">
                                Column to rename / drop
                              </span>
                            </label>
                            <select
                              className="select select-sm select-bordered w-full"
                              value={mapFrom}
                              onChange={(e) => setMapFrom(e.target.value)}
                            >
                              {columns.map((c) => (
                                <option key={c} value={c}>
                                  {c}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="label py-0.5">
                              <span className="label-text text-xs">
                                New name (leave empty to drop)
                              </span>
                            </label>
                            <input
                              type="text"
                              className="input input-sm input-bordered w-full"
                              placeholder="New column name…"
                              value={mapTo}
                              onChange={(e) => setMapTo(e.target.value)}
                            />
                          </div>
                        </div>
                      )}

                      {/* Join form */}
                      {newStepType === "join" && (
                        <div className="space-y-2">
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <div>
                              <label className="label py-0.5">
                                <span className="label-text text-xs">
                                  Join key column (shared between both datasets)
                                </span>
                              </label>
                              <select
                                className="select select-sm select-bordered w-full"
                                value={joinOn}
                                onChange={(e) => setJoinOn(e.target.value)}
                              >
                                {columns.map((c) => (
                                  <option key={c} value={c}>
                                    {c}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="label py-0.5">
                                <span className="label-text text-xs">
                                  Prefix for right-side columns
                                </span>
                              </label>
                              <input
                                type="text"
                                className="input input-sm input-bordered w-full"
                                placeholder="r_"
                                value={joinPrefix}
                                onChange={(e) => setJoinPrefix(e.target.value)}
                              />
                            </div>
                          </div>
                          <div>
                            <label className="label py-0.5">
                              <span className="label-text text-xs">
                              Right-side data (paste CSV — first-row headers,
                                must include the join key column)
                              </span>
                            </label>
                            <textarea
                              className="textarea textarea-bordered w-full font-mono text-xs"
                              rows={4}
                              placeholder={"id,extra_col\n1,value_a\n2,value_b"}
                              value={joinCsv}
                              onChange={(e) => setJoinCsv(e.target.value)}
                            />
                          </div>
                        </div>
                      )}

                      {/* Form actions */}
                      <div className="flex gap-2 pt-1">
                        <button
                          onClick={handleAddStep}
                          disabled={!isNewStepValid()}
                          className="btn btn-sm btn-primary"
                        >
                          Add
                        </button>
                        <button
                          onClick={() => setShowNewStep(false)}
                          className="btn btn-sm btn-ghost"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
            <hr />
          </li>

          {/* ─────────────────── Step 3: Preview ─────────────────── */}
          <li>
            <hr />
            <div className="timeline-middle">
              {previewDone ? (
                <CheckCircleIcon className="h-5 w-5 text-success" />
              ) : (
                <DotCircleIcon
                  className={`h-5 w-5 ${
                    hasData ? "text-primary" : "text-base-content/30"
                  }`}
                />
              )}
            </div>
            <div className="timeline-end timeline-box mb-6 w-full max-w-none">
              <h3 className="text-sm font-semibold mb-2 text-base-content">
                3 · Preview
              </h3>
              {!hasData ? (
                <p className="text-xs text-base-content/40">
                  Upload data first.
                </p>
              ) : (
                <>
                  <p className="text-xs text-base-content/60 mb-3">
                    {previewData.length} row
                    {previewData.length !== 1 ? "s" : ""}
                    {steps.length > 0
                      ? ` after transforms (${rawData.length - previewData.length} removed)`
                      : ""}
                    .
                  </p>
                  <PreviewTable data={previewData} />
                </>
              )}
            </div>
            <hr />
          </li>

          {/* ─────────────────── Step 4: Export ─────────────────── */}
          <li>
            <hr />
            <div className="timeline-middle">
              <DotCircleIcon
                className={`h-5 w-5 ${
                  previewDone ? "text-primary" : "text-base-content/30"
                }`}
              />
            </div>
            <div className="timeline-end timeline-box w-full max-w-none">
              <h3 className="text-sm font-semibold mb-2 text-base-content">
                4 · Export
              </h3>
              {!previewDone ? (
                <p className="text-xs text-base-content/40">
                  Complete the steps above first.
                </p>
              ) : (
                <div className="flex gap-3 flex-wrap">
                  <button
                    onClick={() => {
                      try {
                        exportXLSX(previewData);
                      } catch (err) {
                        setExportError(
                          err instanceof Error ? err.message : "Export failed."
                        );
                      }
                    }}
                    className="btn btn-sm btn-primary"
                  >
                    ↓ Download Excel (.xlsx)
                  </button>
                  <button
                    onClick={() => window.print()}
                    className="btn btn-sm btn-outline"
                  >
                    ⊞ Print Report
                  </button>
                </div>
              )}
              {exportError && (
                <p className="text-xs text-error mt-2">✕ {exportError}</p>
              )}
            </div>
          </li>
        </ul>
      </div>

      {/* ── Print view (shown only during print, hidden on screen) ── */}
      <div className="hidden print:block">
        <h1 className="text-xl font-bold mb-1">TemcoTools — Report Export</h1>
        <PreviewTable data={previewData} />
      </div>
    </>
  );
}
