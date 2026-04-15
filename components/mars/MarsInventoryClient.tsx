"use client";

import { useEffect, useState, useTransition } from "react";
import type { MarsUnitListItem } from "@/lib/mars/inventory";

interface MarsInventoryResponse {
  ok: true;
  items: MarsUnitListItem[];
  page: number;
  limit: number;
  totalCount: number;
  totalPages: number;
}

interface MarsInventoryClientProps {
  initialResponse: MarsInventoryResponse;
}

export default function MarsInventoryClient({ initialResponse }: MarsInventoryClientProps) {
  const [query, setQuery] = useState("");
  const [stagedFilter, setStagedFilter] = useState<"all" | "true" | "false">("all");
  const [data, setData] = useState(initialResponse);
  const [page, setPage] = useState(initialResponse.page);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    startTransition(async () => {
      const searchParams = new URLSearchParams();
      if (query.trim()) searchParams.set("q", query.trim());
      if (stagedFilter !== "all") searchParams.set("staged", stagedFilter);
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
  }, [initialResponse.limit, page, query, stagedFilter]);

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

  return (
    <div className="space-y-5">
      <section className="card bg-base-100 border border-base-200 shadow-sm">
        <div className="card-body">
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_220px] gap-4">
            <label className="form-control">
              <span className="label-text mb-2">Search</span>
              <input
                type="search"
                value={query}
                onChange={(event) => {
                  setPage(1);
                  setQuery(event.target.value);
                }}
                placeholder="Request number, serial, vendor, or model"
                className="input input-bordered w-full"
              />
            </label>

            <label className="form-control">
              <span className="label-text mb-2">Staged Filter</span>
              <select
                className="select select-bordered"
                value={stagedFilter}
                onChange={(event) => {
                  setPage(1);
                  setStagedFilter(event.target.value as "all" | "true" | "false");
                }}
              >
                <option value="all">All Units</option>
                <option value="true">Staged Only</option>
                <option value="false">Unstaged Only</option>
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-base-content/70">
            <p>
              Showing {data.items.length} of {data.totalCount} units
            </p>
            <p>{isPending ? "Refreshing..." : `Page ${data.page} of ${data.totalPages}`}</p>
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
                <th>Request</th>
                <th>Vendor</th>
                <th>Serial</th>
                <th>Model</th>
                <th>Request Status</th>
                <th>Return Status</th>
                <th>Staged</th>
                <th>Last Imported</th>
                <th>Last Audit Seen</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.items.length ? (
                data.items.map((item) => (
                  <tr key={item.requestNumber}>
                    <td className="font-medium">{item.requestNumber}</td>
                    <td>{item.vendor ?? "—"}</td>
                    <td>{item.serialNumber ?? "—"}</td>
                    <td>{item.modelNumber ?? "—"}</td>
                    <td>{item.requestStatus ?? "—"}</td>
                    <td>{item.returnStatus ?? "—"}</td>
                    <td>
                      <span className={`badge ${item.staged ? "badge-success" : "badge-ghost"}`}>
                        {item.staged ? "Staged" : "Not staged"}
                      </span>
                    </td>
                    <td>{formatDate(item.lastImportedAt)}</td>
                    <td>{formatDate(item.lastAuditSeenAt)}</td>
                    <td>
                      <button
                        className={`btn btn-xs ${item.staged ? "btn-outline" : "btn-primary"}`}
                        onClick={() => handleToggle(item.requestNumber, !item.staged)}
                      >
                        {item.staged ? "Unstage" : "Mark staged"}
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={10} className="text-center text-base-content/60 py-10">
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

function formatDate(value: string | Date | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}
