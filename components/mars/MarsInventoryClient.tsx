"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import type {
  MarsReturnStatusMode,
  MarsUnitFilterOptions,
  MarsUnitListItem,
  MarsUnitSortField,
  SortDirection,
} from "@/lib/mars/inventory";

interface MarsInventoryResponse {
  ok: true;
  items: MarsUnitListItem[];
  page: number;
  limit: number;
  totalCount: number;
  totalPages: number;
  filterOptions: MarsUnitFilterOptions;
}

interface MarsInventoryClientProps {
  initialResponse: MarsInventoryResponse;
}

type ColumnId =
  | "requestNumber"
  | "orderNumber"
  | "vendor"
  | "serialNumber"
  | "modelNumber"
  | "vendorRaNumber"
  | "dateRequested"
  | "requestStatus"
  | "returnStatus"
  | "replacementNeeded"
  | "staged"
  | "lastImportedAt"
  | "lastAuditSeenAt";

interface FilterState {
  q: string;
  requestNumber: string;
  orderNumber: string;
  vendor: string;
  serialNumber: string;
  modelNumber: string;
  vendorRaNumber: string;
  requestStatus: string;
  returnStatus: string;
  replacementNeeded: string;
  staged: "all" | "true" | "false";
  returnStatusMode: MarsReturnStatusMode;
  dateRequestedOn: string;
  lastImportedOn: string;
  lastAuditSeenOn: string;
}

const DEFAULT_FILTERS: FilterState = {
  q: "",
  requestNumber: "",
  orderNumber: "",
  vendor: "",
  serialNumber: "",
  modelNumber: "",
  vendorRaNumber: "",
  requestStatus: "",
  returnStatus: "",
  replacementNeeded: "",
  staged: "all",
  returnStatusMode: "exclude_received",
  dateRequestedOn: "",
  lastImportedOn: "",
  lastAuditSeenOn: "",
};

const DEFAULT_VISIBLE_COLUMNS: ColumnId[] = [
  "requestNumber",
  "vendor",
  "serialNumber",
  "modelNumber",
  "requestStatus",
  "returnStatus",
  "staged",
  "lastImportedAt",
  "lastAuditSeenAt",
];

const COLUMN_STORAGE_KEY = "mars_inventory_visible_columns_v1";

const ALL_COLUMNS: Array<{ id: ColumnId; label: string; sortField: MarsUnitSortField }> = [
  { id: "requestNumber", label: "Request", sortField: "requestNumber" },
  { id: "orderNumber", label: "Order", sortField: "orderNumber" },
  { id: "vendor", label: "Vendor", sortField: "vendor" },
  { id: "serialNumber", label: "Serial", sortField: "serialNumber" },
  { id: "modelNumber", label: "Model", sortField: "modelNumber" },
  { id: "vendorRaNumber", label: "Vendor RA", sortField: "vendorRaNumber" },
  { id: "dateRequested", label: "Date Requested", sortField: "dateRequested" },
  { id: "requestStatus", label: "Request Status", sortField: "requestStatus" },
  { id: "returnStatus", label: "Return Status", sortField: "returnStatus" },
  { id: "replacementNeeded", label: "Replacement Needed", sortField: "replacementNeeded" },
  { id: "staged", label: "Staged", sortField: "staged" },
  { id: "lastImportedAt", label: "Last Imported", sortField: "lastImportedAt" },
  { id: "lastAuditSeenAt", label: "Last Audit Seen", sortField: "lastAuditSeenAt" },
];

export default function MarsInventoryClient({ initialResponse }: MarsInventoryClientProps) {
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [sortBy, setSortBy] = useState<MarsUnitSortField>("requestNumber");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [data, setData] = useState(initialResponse);
  const [page, setPage] = useState(initialResponse.page);
  const [visibleColumns, setVisibleColumns] = useState<ColumnId[]>(DEFAULT_VISIBLE_COLUMNS);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    const raw = window.localStorage.getItem(COLUMN_STORAGE_KEY);
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as ColumnId[];
      const sanitized = parsed.filter((column): column is ColumnId =>
        ALL_COLUMNS.some((candidate) => candidate.id === column)
      );
      if (sanitized.length) {
        setVisibleColumns(sanitized);
      }
    } catch {
      window.localStorage.removeItem(COLUMN_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(visibleColumns));
  }, [visibleColumns]);

  useEffect(() => {
    startTransition(async () => {
      const searchParams = new URLSearchParams();
      pushParam(searchParams, "q", filters.q);
      pushParam(searchParams, "requestNumber", filters.requestNumber);
      pushParam(searchParams, "orderNumber", filters.orderNumber);
      pushParam(searchParams, "vendor", filters.vendor);
      pushParam(searchParams, "serialNumber", filters.serialNumber);
      pushParam(searchParams, "modelNumber", filters.modelNumber);
      pushParam(searchParams, "vendorRaNumber", filters.vendorRaNumber);
      pushParam(searchParams, "requestStatus", filters.requestStatus);
      pushParam(searchParams, "returnStatus", filters.returnStatus);
      pushParam(searchParams, "replacementNeeded", filters.replacementNeeded);
      pushParam(searchParams, "dateRequestedOn", filters.dateRequestedOn);
      pushParam(searchParams, "lastImportedOn", filters.lastImportedOn);
      pushParam(searchParams, "lastAuditSeenOn", filters.lastAuditSeenOn);
      if (filters.staged !== "all") searchParams.set("staged", filters.staged);
      searchParams.set("returnStatusMode", filters.returnStatusMode);
      searchParams.set("sortBy", sortBy);
      searchParams.set("sortDirection", sortDirection);
      searchParams.set("page", String(page));
      searchParams.set("limit", String(initialResponse.limit));

      const response = await fetch(`/api/mars/units?${searchParams.toString()}`);
      const payload = (await response.json()) as MarsInventoryResponse | { error?: string };

      if (!response.ok || !("ok" in payload)) {
        setError("error" in payload ? payload.error ?? "Failed to load inventory." : "Failed to load inventory.");
        return;
      }

      setError(null);
      setData(payload);
    });
  }, [filters, initialResponse.limit, page, sortBy, sortDirection]);

  const columnLookup = useMemo(
    () => new Map(ALL_COLUMNS.map((column) => [column.id, column] as const)),
    []
  );
  const activeColumns = visibleColumns
    .map((columnId) => columnLookup.get(columnId))
    .filter((column): column is (typeof ALL_COLUMNS)[number] => Boolean(column));

  async function handleToggle(requestNumber: string, staged: boolean) {
    const response = await fetch(`/api/mars/unit/${encodeURIComponent(requestNumber)}/stage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ staged }),
    });

    const payload = (await response.json()) as
      | { ok: true; unit: MarsUnitListItem }
      | { ok: false; error: string };

    if (!response.ok || !payload.ok) {
      setError("error" in payload ? payload.error : "Failed to update staged state.");
      return;
    }

    setError(null);
    setData((current) => ({
      ...current,
      items: current.items.map((item) =>
        item.requestNumber === requestNumber ? payload.unit : item
      ),
    }));
  }

  function updateFilter<K extends keyof FilterState>(key: K, value: FilterState[K]) {
    setPage(1);
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function toggleColumn(columnId: ColumnId) {
    setVisibleColumns((current) => {
      if (current.includes(columnId)) {
        return current.length > 1 ? current.filter((value) => value !== columnId) : current;
      }
      return [...current, columnId];
    });
  }

  function resetFilters() {
    setPage(1);
    setSortBy("requestNumber");
    setSortDirection("asc");
    setFilters(DEFAULT_FILTERS);
  }

  function handleSort(field: MarsUnitSortField) {
    setPage(1);
    if (sortBy === field) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortBy(field);
    setSortDirection("asc");
  }

  return (
    <div className="space-y-5">
      <section className="card bg-base-100 border border-base-200 shadow-sm">
        <div className="card-body gap-4">
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_240px_240px] gap-4">
            <label className="form-control">
              <span className="label-text mb-2">Quick Search</span>
              <input
                type="search"
                value={filters.q}
                onChange={(event) => updateFilter("q", event.target.value)}
                placeholder="Request, serial, vendor, model, order, or vendor RA"
                className="input input-bordered w-full"
              />
            </label>

            <label className="form-control">
              <span className="label-text mb-2">Return Status View</span>
              <select
                className="select select-bordered"
                value={filters.returnStatusMode}
                onChange={(event) =>
                  updateFilter("returnStatusMode", event.target.value as MarsReturnStatusMode)
                }
              >
                <option value="exclude_received">Working Inventory</option>
                <option value="all">All Return Statuses</option>
                <option value="received_only">Received Only</option>
              </select>
            </label>

            <div className="form-control">
              <span className="label-text mb-2">Columns</span>
              <details className="dropdown">
                <summary className="btn btn-outline justify-between">
                  {visibleColumns.length} visible
                </summary>
                <div className="dropdown-content z-[1] mt-2 w-72 rounded-box border border-base-200 bg-base-100 p-3 shadow-lg">
                  <div className="grid grid-cols-1 gap-2">
                    {ALL_COLUMNS.map((column) => (
                      <label key={column.id} className="label cursor-pointer justify-start gap-3">
                        <input
                          type="checkbox"
                          className="checkbox checkbox-sm"
                          checked={visibleColumns.includes(column.id)}
                          onChange={() => toggleColumn(column.id)}
                        />
                        <span className="label-text">{column.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </details>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-base-content/70">
            <p>
              Showing {data.items.length} of {data.totalCount} units
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <span>{isPending ? "Refreshing..." : `Page ${data.page} of ${data.totalPages}`}</span>
              <button className="btn btn-xs btn-ghost" onClick={resetFilters}>
                Reset filters
              </button>
              <button
                className="btn btn-xs btn-ghost"
                onClick={() => setVisibleColumns(DEFAULT_VISIBLE_COLUMNS)}
              >
                Reset columns
              </button>
            </div>
          </div>

          {error ? (
            <div className="alert alert-error">
              <span>{error}</span>
            </div>
          ) : null}
        </div>
      </section>

      <section className="card bg-base-100 border border-base-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table table-zebra">
            <thead>
              <tr>
                {activeColumns.map((column) => (
                  <th key={column.id}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs px-0 normal-case font-semibold"
                      onClick={() => handleSort(column.sortField)}
                    >
                      {column.label}
                      <SortIndicator
                        active={sortBy === column.sortField}
                        direction={sortDirection}
                      />
                    </button>
                  </th>
                ))}
                <th>Actions</th>
              </tr>
              <tr>
                {activeColumns.map((column) => (
                  <th key={`${column.id}-filter`}>{renderFilterControl(column.id, filters, data.filterOptions, updateFilter)}</th>
                ))}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.items.length ? (
                data.items.map((item) => (
                  <tr key={item.requestNumber}>
                    {activeColumns.map((column) => (
                      <td key={`${item.requestNumber}-${column.id}`}>
                        {renderCell(column.id, item, handleToggle)}
                      </td>
                    ))}
                    <td>
                      <Link
                        href={`/tools/mars/inventory/${encodeURIComponent(item.requestNumber)}`}
                        className="btn btn-xs btn-outline"
                      >
                        Details
                      </Link>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={activeColumns.length + 1} className="text-center text-base-content/60 py-10">
                    No MARS units match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="flex items-center justify-between">
        <button
          className="btn btn-outline"
          disabled={data.page <= 1 || isPending}
          onClick={() => setPage((current) => Math.max(1, current - 1))}
        >
          Previous
        </button>
        <button
          className="btn btn-outline"
          disabled={data.page >= data.totalPages || isPending}
          onClick={() => setPage((current) => current + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}

function renderCell(
  columnId: ColumnId,
  item: MarsUnitListItem,
  handleToggle: (requestNumber: string, staged: boolean) => void
) {
  switch (columnId) {
    case "requestNumber":
      return (
        <Link
          href={`/tools/mars/inventory/${encodeURIComponent(item.requestNumber)}`}
          className="link link-primary font-medium"
        >
          {item.requestNumber}
        </Link>
      );
    case "orderNumber":
      return item.orderNumber ?? "—";
    case "vendor":
      return item.vendor ?? "—";
    case "serialNumber":
      return item.serialNumber ?? "—";
    case "modelNumber":
      return item.modelNumber ?? "—";
    case "vendorRaNumber":
      return item.vendorRaNumber ?? "—";
    case "dateRequested":
      return formatDate(item.dateRequested, false);
    case "requestStatus":
      return item.requestStatus ?? "—";
    case "returnStatus":
      return item.returnStatus ?? "—";
    case "replacementNeeded":
      return item.replacementNeeded ?? "—";
    case "staged":
      return (
        <button
          className={`btn btn-xs ${item.staged ? "btn-success" : "btn-outline"}`}
          onClick={() => handleToggle(item.requestNumber, !item.staged)}
        >
          {item.staged ? "Staged" : "Not staged"}
        </button>
      );
    case "lastImportedAt":
      return formatDate(item.lastImportedAt);
    case "lastAuditSeenAt":
      return formatDate(item.lastAuditSeenAt);
    default:
      return "—";
  }
}

function renderFilterControl(
  columnId: ColumnId,
  filters: FilterState,
  filterOptions: MarsUnitFilterOptions,
  updateFilter: <K extends keyof FilterState>(key: K, value: FilterState[K]) => void
) {
  switch (columnId) {
    case "requestNumber":
    case "orderNumber":
    case "vendor":
    case "serialNumber":
    case "modelNumber":
    case "vendorRaNumber":
      return (
        <input
          type="text"
          value={filters[columnId]}
          onChange={(event) => updateFilter(columnId, event.target.value)}
          className="input input-bordered input-xs w-full min-w-28"
          placeholder="Filter"
        />
      );
    case "requestStatus":
      return (
        <select
          className="select select-bordered select-xs w-full min-w-32"
          value={filters.requestStatus}
          onChange={(event) => updateFilter("requestStatus", event.target.value)}
        >
          <option value="">All</option>
          {filterOptions.requestStatuses.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      );
    case "returnStatus":
      return (
        <select
          className="select select-bordered select-xs w-full min-w-32"
          value={filters.returnStatus}
          onChange={(event) => updateFilter("returnStatus", event.target.value)}
        >
          <option value="">All</option>
          {filterOptions.returnStatuses.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      );
    case "replacementNeeded":
      return (
        <select
          className="select select-bordered select-xs w-full min-w-28"
          value={filters.replacementNeeded}
          onChange={(event) => updateFilter("replacementNeeded", event.target.value)}
        >
          <option value="">All</option>
          {filterOptions.replacementNeededOptions.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      );
    case "staged":
      return (
        <select
          className="select select-bordered select-xs w-full min-w-28"
          value={filters.staged}
          onChange={(event) => updateFilter("staged", event.target.value as FilterState["staged"])}
        >
          <option value="all">All</option>
          <option value="true">Staged</option>
          <option value="false">Not staged</option>
        </select>
      );
    case "dateRequested":
      return (
        <input
          type="date"
          value={filters.dateRequestedOn}
          onChange={(event) => updateFilter("dateRequestedOn", event.target.value)}
          className="input input-bordered input-xs w-full min-w-36"
        />
      );
    case "lastImportedAt":
      return (
        <input
          type="date"
          value={filters.lastImportedOn}
          onChange={(event) => updateFilter("lastImportedOn", event.target.value)}
          className="input input-bordered input-xs w-full min-w-36"
        />
      );
    case "lastAuditSeenAt":
      return (
        <input
          type="date"
          value={filters.lastAuditSeenOn}
          onChange={(event) => updateFilter("lastAuditSeenOn", event.target.value)}
          className="input input-bordered input-xs w-full min-w-36"
        />
      );
    default:
      return null;
  }
}

function SortIndicator({ active, direction }: { active: boolean; direction: SortDirection }) {
  if (!active) {
    return <span className="text-base-content/40">↕</span>;
  }
  return <span>{direction === "asc" ? "↑" : "↓"}</span>;
}

function pushParam(searchParams: URLSearchParams, key: string, value: string) {
  const trimmed = value.trim();
  if (trimmed) {
    searchParams.set(key, trimmed);
  }
}

function formatDate(value: string | Date | null, includeTime = true) {
  if (!value) return "—";

  const date = new Date(value);
  return includeTime ? date.toLocaleString() : date.toLocaleDateString();
}
