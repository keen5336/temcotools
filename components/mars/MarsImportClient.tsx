"use client";

import { useState, useTransition } from "react";
import type { MarsImportBatchSummary } from "@/lib/mars/inventory";
import type { MarsImportSummary } from "@/lib/mars/import";

interface MarsImportClientProps {
  latestBatch: MarsImportBatchSummary | null;
}

interface ImportFailure {
  ok: false;
  error: string;
}

export default function MarsImportClient({ latestBatch }: MarsImportClientProps) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<MarsImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) {
      setError("Select a spreadsheet file before importing.");
      return;
    }

    startTransition(async () => {
      setError(null);
      setResult(null);

      const formData = new FormData();
      formData.set("file", file);

      const response = await fetch("/api/mars/import", {
        method: "POST",
        body: formData,
      });

      const payload = (await response.json()) as MarsImportSummary | ImportFailure;
      if (!response.ok || !payload.ok) {
        setError("error" in payload ? payload.error : "Import failed.");
        return;
      }

      setResult(payload);
      setFile(null);
      event.currentTarget.reset();
    });
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)] gap-6">
      <section className="card bg-base-100 border border-base-200 shadow-sm">
        <div className="card-body">
          <h2 className="card-title">Upload MARS Spreadsheet</h2>
          <p className="text-sm text-base-content/70">
            Import the latest MARS workbook. Request Number remains the authority key for local
            tracking records.
          </p>

          <form className="space-y-4" onSubmit={handleSubmit}>
            <fieldset disabled={isPending} className="space-y-4">
              <label className="form-control w-full">
                <span className="label-text mb-2">Spreadsheet file</span>
                <input
                  type="file"
                  accept=".xlsx,.xls"
                  className="file-input file-input-bordered w-full"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
              </label>

              <button type="submit" className={`btn btn-primary ${isPending ? "btn-disabled" : ""}`}>
                {isPending ? "Importing..." : "Import Spreadsheet"}
              </button>
            </fieldset>
          </form>

          {error ? (
            <div className="alert alert-error mt-4">
              <span>{error}</span>
            </div>
          ) : null}

          {result ? (
            <div className="mt-4 rounded-xl border border-success/20 bg-success/5 p-4 space-y-3">
              <div>
                <h3 className="font-semibold text-base-content">Latest Upload Result</h3>
                <p className="text-sm text-base-content/70">{result.filename}</p>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                <Metric label="Rows" value={result.rowCount} />
                <Metric label="Inserted" value={result.insertedCount} />
                <Metric label="Updated" value={result.updatedCount} />
                <Metric label="Skipped" value={result.skippedCount} />
                <Metric label="Warnings" value={result.warnings.length} />
                <Metric label="Batch" value={result.batchId.slice(0, 8)} />
              </div>

              {result.warnings.length ? (
                <div>
                  <p className="text-sm font-medium mb-2">Warnings</p>
                  <ul className="text-sm text-base-content/80 space-y-1">
                    {result.warnings.map((warning) => (
                      <li key={warning}>• {warning}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <section className="card bg-base-100 border border-base-200 shadow-sm">
        <div className="card-body">
          <h2 className="card-title">Most Recent Import</h2>
          {latestBatch ? (
            <div className="space-y-4">
              <div>
                <p className="font-medium text-base-content">{latestBatch.filename}</p>
                <p className="text-sm text-base-content/70">
                  Uploaded {new Date(latestBatch.uploadedAt).toLocaleString()}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <Metric label="Rows" value={latestBatch.rowCount} />
                <Metric label="Inserted" value={latestBatch.insertedCount} />
                <Metric label="Updated" value={latestBatch.updatedCount} />
                <Metric label="Skipped" value={latestBatch.skippedCount} />
              </div>

              {latestBatch.notes ? (
                <div>
                  <p className="text-sm font-medium mb-2">Notes</p>
                  <p className="text-sm text-base-content/75 whitespace-pre-wrap">
                    {latestBatch.notes}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-base-content/60">No warnings recorded.</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-base-content/60">
              No MARS imports have been recorded yet.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-base-200 bg-base-200/40 p-3">
      <p className="text-xs uppercase tracking-wide text-base-content/60">{label}</p>
      <p className="text-lg font-semibold text-base-content">{value}</p>
    </div>
  );
}
