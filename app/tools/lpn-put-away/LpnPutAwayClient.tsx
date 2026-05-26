"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const XLSX_CDN_URL =
  "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";

const REQUIRED_COLUMNS = [
  "LPN",
  "Status",
  "Order Number",
  "Vendor",
  "Received Date",
  "Description",
  "Deliver to:",
] as const;

type SourceRow = Record<string, unknown>;

type SheetJs = {
  read: (
    data: Uint8Array,
    options: Record<string, unknown>
  ) => {
    SheetNames: string[];
    Sheets: Record<string, unknown>;
  };
  utils: {
    sheet_to_json: (
      worksheet: unknown,
      options: Record<string, unknown>
    ) => Record<string, unknown>[];
  };
};

type PutAwayRow = {
  lpn: string;
  vendor: string;
  customerName: string;
  orderNumber: string;
  description: string;
};

function todayInputValue() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function normalizeHeader(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ").replace(/:$/, "");
}

function findColumn(row: SourceRow | undefined, columnName: string) {
  if (!row) return null;
  const expected = normalizeHeader(columnName);
  return (
    Object.keys(row).find((key) => normalizeHeader(key) === expected) ?? null
  );
}

function valueToString(value: unknown) {
  if (value == null) return "";
  if (value instanceof Date) return value.toLocaleDateString();
  return String(value).trim();
}

function excelSerialToInputDate(serial: number) {
  const millis = Math.round((serial - 25569) * 86_400_000);
  return new Date(millis).toISOString().slice(0, 10);
}

function parseDateLike(value: unknown) {
  if (value == null || value === "") return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 10);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return excelSerialToInputDate(value);
  }
  const text = String(value).trim();
  if (!text) return "";
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 20_000 && numeric < 80_000) {
    return excelSerialToInputDate(numeric);
  }
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 10);
  }
  return "";
}

function parseWorkbook(buffer: ArrayBuffer) {
  const xlsx = window.XLSX as SheetJs | undefined;
  if (!xlsx) throw new Error("Spreadsheet parser is not loaded yet.");

  const workbook = xlsx.read(new Uint8Array(buffer), {
    type: "array",
    cellDates: true,
  });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new Error("The workbook does not contain a sheet.");

  return xlsx.utils.sheet_to_json(workbook.Sheets[firstSheetName], {
    defval: "",
    raw: true,
  });
}

function escapeCsvCell(value: string) {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function downloadCsv(rows: PutAwayRow[], dateValue: string) {
  const headers = [
    "LPN",
    "Vendor",
    "Customer Name",
    "Order Number",
    "Description",
  ];
  const body = rows.map((row) =>
    [
      row.lpn,
      row.vendor,
      row.customerName,
      row.orderNumber,
      row.description,
    ]
      .map(escapeCsvCell)
      .join(",")
  );
  const blob = new Blob([[headers.join(","), ...body].join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `lpn-put-away-${dateValue}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export default function LpnPutAwayClient() {
  const [xlsxLoaded, setXlsxLoaded] = useState(false);
  const [xlsxLoadError, setXlsxLoadError] = useState("");
  const [selectedDate, setSelectedDate] = useState(todayInputValue);
  const [rows, setRows] = useState<SourceRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [fileError, setFileError] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const columns = useMemo(() => {
    const first = rows[0];
    return {
      lpn: findColumn(first, "LPN"),
      status: findColumn(first, "Status"),
      orderNumber: findColumn(first, "Order Number"),
      vendor: findColumn(first, "Vendor"),
      receivedDate: findColumn(first, "Received Date"),
      description: findColumn(first, "Description"),
      customerName: findColumn(first, "Deliver to:"),
    };
  }, [rows]);

  const missingColumns = useMemo(() => {
    if (rows.length === 0) return [];
    return REQUIRED_COLUMNS.filter((column) => !findColumn(rows[0], column));
  }, [rows]);

  const results = useMemo(() => {
    const {
      lpn,
      status,
      orderNumber,
      vendor,
      receivedDate,
      description,
      customerName,
    } = columns;
    if (
      !lpn ||
      !status ||
      !orderNumber ||
      !vendor ||
      !receivedDate ||
      !description ||
      !customerName
    ) {
      return [];
    }

    return rows
      .filter((row) => {
        const rowStatus = valueToString(row[status]).toLowerCase();
        return (
          rowStatus === "placing" &&
          parseDateLike(row[receivedDate]) === selectedDate
        );
      })
      .map((row) => ({
        lpn: valueToString(row[lpn]),
        vendor: valueToString(row[vendor]),
        customerName: valueToString(row[customerName]),
        orderNumber: valueToString(row[orderNumber]),
        description: valueToString(row[description]),
      }));
  }, [columns, rows, selectedDate]);

  const lpnList = useMemo(
    () => results.map((row) => row.lpn).filter(Boolean).join("\n"),
    [results]
  );

  function readFile(file: File) {
    setFileName(file.name);
    setFileError("");
    setCopyStatus("");

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const buffer = event.target?.result;
        if (!(buffer instanceof ArrayBuffer)) {
          throw new Error("Unable to read the selected file.");
        }
        const parsed = parseWorkbook(buffer);
        setRows(parsed);
      } catch (error) {
        setRows([]);
        setFileError(
          error instanceof Error
            ? error.message
            : "Failed to parse file. Make sure it is a valid .xlsx workbook."
        );
      }
    };
    reader.onerror = () => {
      setRows([]);
      setFileError("Unable to read the selected file.");
    };
    reader.readAsArrayBuffer(file);
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) readFile(file);
  }

  async function handleCopyLpns() {
    if (!lpnList) return;
    await navigator.clipboard.writeText(lpnList);
    setCopyStatus(`Copied ${results.length} LPNs`);
  }

  const hasRows = rows.length > 0;
  const canUseWorkbook = hasRows && missingColumns.length === 0;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[20rem_minmax(0,1fr)] gap-6 items-start">
      <aside className="card bg-base-100 border border-base-200 shadow-sm">
        <div className="card-body gap-5">
          <div className="form-control">
            <label className="label" htmlFor="received-date">
              <span className="label-text font-medium">Received Date</span>
            </label>
            <input
              id="received-date"
              type="date"
              className="input input-bordered"
              value={selectedDate}
              onChange={(event) => {
                setSelectedDate(event.target.value);
                setCopyStatus("");
              }}
            />
          </div>

          <div
            className={`rounded-lg border border-dashed p-5 text-center transition ${
              isDragging
                ? "border-primary bg-primary/10"
                : "border-base-300 bg-base-200/50"
            }`}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setIsDragging(false);
              const file = event.dataTransfer.files[0];
              if (file) readFile(file);
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={handleFileChange}
              disabled={!xlsxLoaded}
            />
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={!xlsxLoaded}
            >
              Upload Spreadsheet
            </button>
            <p className="text-xs text-base-content/60 mt-3">
              Drag and drop the LPN report here.
            </p>
          </div>

          {xlsxLoadError && (
            <div className="alert alert-error text-sm">{xlsxLoadError}</div>
          )}
          {!xlsxLoaded && !xlsxLoadError && (
            <div className="flex items-center gap-2 text-sm text-base-content/60">
              <span className="loading loading-spinner loading-xs" />
              Loading spreadsheet parser
            </div>
          )}
          {fileError && <div className="alert alert-error text-sm">{fileError}</div>}
          {hasRows && (
            <div className="text-sm text-base-content/70">
              <div className="font-medium text-base-content truncate">
                {fileName}
              </div>
              <div>{rows.length.toLocaleString()} source rows loaded</div>
            </div>
          )}
          {missingColumns.length > 0 && (
            <div className="alert alert-warning text-sm">
              Missing columns: {missingColumns.join(", ")}
            </div>
          )}

          <div className="stats stats-vertical bg-base-200">
            <div className="stat py-3">
              <div className="stat-title">Placing Rows</div>
              <div className="stat-value text-2xl">{results.length}</div>
            </div>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-sm btn-outline flex-1"
              onClick={handleCopyLpns}
              disabled={results.length === 0}
            >
              Copy LPNs
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline flex-1"
              onClick={() => downloadCsv(results, selectedDate)}
              disabled={results.length === 0}
            >
              CSV
            </button>
          </div>
          {copyStatus && (
            <p className="text-xs text-success text-center">{copyStatus}</p>
          )}
        </div>
      </aside>

      <section className="min-w-0">
        {!hasRows ? (
          <div className="flex items-center justify-center min-h-72 border border-dashed border-base-300 rounded-lg text-base-content/50 text-sm">
            Filtered LPNs will appear here
          </div>
        ) : !canUseWorkbook ? (
          <div className="flex items-center justify-center min-h-72 border border-dashed border-warning rounded-lg text-warning text-sm px-4 text-center">
            The workbook loaded, but the expected report columns were not found.
          </div>
        ) : results.length === 0 ? (
          <div className="flex items-center justify-center min-h-72 border border-dashed border-base-300 rounded-lg text-base-content/50 text-sm px-4 text-center">
            No Placing rows found for the selected received date.
          </div>
        ) : (
          <div className="overflow-x-auto bg-base-100 border border-base-200 rounded-lg shadow-sm">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>LPN</th>
                  <th>Vendor</th>
                  <th>Customer Name</th>
                  <th>Order Number</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {results.map((row, index) => (
                  <tr key={`${row.lpn}-${row.orderNumber}-${index}`}>
                    <td className="font-mono whitespace-nowrap">{row.lpn}</td>
                    <td className="whitespace-nowrap">{row.vendor}</td>
                    <td className="whitespace-nowrap">{row.customerName}</td>
                    <td className="font-mono whitespace-nowrap">
                      {row.orderNumber}
                    </td>
                    <td className="min-w-80">{row.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
