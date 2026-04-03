"use client";

import { useState, useMemo, useRef } from "react";
import * as XLSX from "xlsx";
import {
  executePipeline,
  type Step,
  type FilterOperator,
} from "@/lib/pipeline/executePipeline";
import PreviewTable from "@/components/PreviewTable";

// ── Types ─────────────────────────────────────────────────────────────────────

type StepWithId = Step & { id: string };

// ── Excel / Spreadsheet Helpers ───────────────────────────────────────────────

function parseWorkbook(
  workbook: XLSX.WorkBook
): Record<string, unknown>[] {
  if (workbook.SheetNames.length > 1) {
    console.warn(
      `Workbook has ${workbook.SheetNames.length} sheets. Using the first sheet: "${workbook.SheetNames[0]}".`
    );
  }
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet);
}

function exportXLSX(
  data: Record<string, unknown>[],
  filename = "report-export.xlsx"
): void {
  if (data.length === 0) return;
  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Report");
  XLSX.writeFile(workbook, filename);
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
  // ─ Data state
  const [rawData, setRawData] = useState<Record<string, unknown>[]>([]);
  const [fileName, setFileName] = useState<string>("");
  const [steps, setSteps] = useState<StepWithId[]>([]);

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
    const reader = new FileReader();
    reader.onload = (ev) => {
      const buffer = ev.target?.result as ArrayBuffer;
      const workbook = XLSX.read(buffer);
      const parsed = parseWorkbook(workbook);
      setRawData(parsed);
      setSteps([]);
      setShowNewStep(false);
    };
    reader.readAsArrayBuffer(file);
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
        const wb = XLSX.read(joinCsv, { type: "string" });
        const parsed = XLSX.utils.sheet_to_json<Record<string, unknown>>(
          wb.Sheets[wb.SheetNames[0]]
        );
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
                />
              </div>
              {hasData && (
                <p className="text-xs text-success mt-2">
                  ✓ Loaded <strong>{rawData.length}</strong> rows ·{" "}
                  <strong>{columns.length}</strong> columns from{" "}
                  <em>{fileName}</em>
                </p>
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
                                Right-side CSV (paste — first-row headers, must
                                include the join key column)
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
                    onClick={() => exportXLSX(previewData)}
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
