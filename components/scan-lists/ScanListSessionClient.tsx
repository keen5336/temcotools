"use client";

import Link from "next/link";

interface ScanListDetail {
  id: string;
  name: string;
  createdAt: string;
  closedAt: string | null;
  archivedAt: string | null;
  createdBy: string | null;
  items: Array<{ id: string; scannedValue: string; createdAt: string }>;
}

export default function ScanListSessionClient({ initialList }: { initialList: ScanListDetail }) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <h1 className="text-2xl font-semibold">{initialList.name}</h1>
            <span className="badge badge-ghost">{initialList.archivedAt ? "Archived" : "Saved"}</span>
          </div>
          <p className="text-base-content/70">
            {initialList.items.length} {initialList.items.length === 1 ? "scan" : "scans"} · Started {formatDate(initialList.createdAt)}
            {initialList.createdBy ? ` by ${initialList.createdBy}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/tools/scan-lists" className="btn btn-outline">Back to Lists</Link>
          <a href={`/api/scan-lists/${encodeURIComponent(initialList.id)}/export`} className="btn btn-primary">Export CSV</a>
        </div>
      </div>

      <section className="card bg-base-100 border border-base-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-base-200">
          <h2 className="text-lg font-semibold">Scans</h2>
          <p className="text-sm text-base-content/70 mt-1">Newest scan first. Duplicates are preserved.</p>
        </div>
        <div className="max-h-[700px] overflow-auto">
          <table className="table table-zebra">
            <thead className="sticky top-0 bg-base-100 z-[1]"><tr><th className="w-24">#</th><th>Scanned Value</th><th>Time</th></tr></thead>
            <tbody>
              {initialList.items.length ? initialList.items.map((item, index) => (
                <tr key={item.id}>
                  <td>{initialList.items.length - index}</td>
                  <td className="font-semibold break-all">{item.scannedValue}</td>
                  <td>{formatDate(item.createdAt)}</td>
                </tr>
              )) : <tr><td colSpan={3} className="text-center text-base-content/60 py-10">No scans in this list.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}
