import Link from "next/link";
import { notFound } from "next/navigation";
import NavBar from "@/components/NavBar";
import MarsNav from "@/components/mars/MarsNav";
import { requireAuth } from "@/lib/auth";
import { getMarsUnitDetail } from "@/lib/mars/inventory";

export default async function MarsInventoryDetailPage({
  params,
}: {
  params: Promise<{ requestNumber: string }>;
}) {
  const session = await requireAuth();
  const { requestNumber } = await params;
  const unit = await getMarsUnitDetail(requestNumber);

  if (!unit) {
    notFound();
  }

  const detailRows = [
    ["Request Number", unit.requestNumber],
    ["Order Number", unit.orderNumber],
    ["Vendor", unit.vendor],
    ["Serial Number", unit.serialNumber],
    ["Model Number", unit.modelNumber],
    ["Vendor RA Number", unit.vendorRaNumber],
    ["Date Requested", formatDate(unit.dateRequested, false)],
    ["Request Status", unit.requestStatus],
    ["Return Status", unit.returnStatus],
    ["Replacement Needed", unit.replacementNeeded],
    ["Staged", unit.staged ? "Yes" : "No"],
    ["Archived", unit.archivedAt ? "Yes" : "No"],
    ["Archive Reason", unit.archivedReason],
    ["Present In Latest Import", unit.presentInLatestImport ? "Yes" : "No"],
    ["Missing From Latest Import At", formatDate(unit.missingFromLatestImportAt)],
    ["Last Imported", formatDate(unit.lastImportedAt)],
    ["Last Scanned", formatDate(unit.lastScannedAt)],
    ["Last Audit Seen", formatDate(unit.lastAuditSeenAt)],
    ["Created", formatDate(unit.createdAt)],
    ["Updated", formatDate(unit.updatedAt)],
  ] as const;

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-[1400px] mx-auto px-4 py-8 space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-base-content mb-1">
              MARS Item {unit.requestNumber}
            </h1>
            <p className="text-base-content/70">
              Full record detail for the imported MARS unit and Temco local activity.
            </p>
          </div>
          <Link href="/tools/mars/inventory" className="btn btn-outline">
            Back to Inventory
          </Link>
        </div>

        <MarsNav />

        <section className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)] gap-6">
          <div className="card bg-base-100 border border-base-200 shadow-sm">
            <div className="card-body">
              <h2 className="card-title">Unit Details</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm">
                {detailRows.map(([label, value]) => (
                  <div key={label}>
                    <p className="text-xs uppercase tracking-[0.18em] text-base-content/50 mb-1">
                      {label}
                    </p>
                    <p className="font-medium break-words">{value ?? "—"}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <section className="card bg-base-100 border border-base-200 shadow-sm">
              <div className="card-body">
                <h2 className="card-title">Latest Import Batch</h2>
                {unit.lastKnownImportBatch ? (
                  <div className="space-y-2 text-sm">
                    <InfoRow label="Filename" value={unit.lastKnownImportBatch.filename} />
                    <InfoRow
                      label="Uploaded"
                      value={formatDate(unit.lastKnownImportBatch.uploadedAt)}
                    />
                    <InfoRow
                      label="Rows"
                      value={String(unit.lastKnownImportBatch.rowCount)}
                    />
                    <InfoRow
                      label="Inserted"
                      value={String(unit.lastKnownImportBatch.insertedCount)}
                    />
                    <InfoRow
                      label="Updated"
                      value={String(unit.lastKnownImportBatch.updatedCount)}
                    />
                    <InfoRow
                      label="Skipped"
                      value={String(unit.lastKnownImportBatch.skippedCount)}
                    />
                    <InfoRow label="Notes" value={unit.lastKnownImportBatch.notes ?? "—"} />
                  </div>
                ) : (
                  <p className="text-sm text-base-content/70">No import batch is linked.</p>
                )}
              </div>
            </section>

            <section className="card bg-base-100 border border-base-200 shadow-sm">
              <div className="card-body">
                <h2 className="card-title">Recent Audit Scans</h2>
                {unit.marsAuditScans.length ? (
                  <div className="space-y-3">
                    {unit.marsAuditScans.map((scan) => (
                      <div key={scan.id} className="rounded-xl border border-base-200 p-3 text-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium">{formatDate(scan.createdAt)}</span>
                          <span className={`badge ${scan.matched ? "badge-success" : "badge-ghost"}`}>
                            {scan.matched ? "Matched" : "Unknown"}
                          </span>
                        </div>
                        <p className="mt-2">Scanned Value: {scan.scannedValue}</p>
                        <p>Duplicate in Session: {scan.duplicateInSession ? "Yes" : "No"}</p>
                        <p>
                          Audit Session: {scan.auditSession.id.slice(0, 8)} (
                          {formatDate(scan.auditSession.startedAt)})
                        </p>
                        <p>
                          User: {scan.user?.displayName ?? scan.user?.username ?? "System / Unknown"}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-base-content/70">No audit scans are recorded.</p>
                )}
              </div>
            </section>
          </div>
        </section>

        <section className="card bg-base-100 border border-base-200 shadow-sm">
          <div className="card-body">
            <h2 className="card-title">Recent Event History</h2>
            {unit.marsEvents.length ? (
              <div className="space-y-4">
                {unit.marsEvents.map((event) => (
                  <div key={event.id} className="rounded-2xl border border-base-200 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="font-semibold">{event.type}</p>
                        <p className="text-sm text-base-content/70">
                          {formatDate(event.createdAt)} by{" "}
                          {event.user?.displayName ?? event.user?.username ?? "System / Unknown"}
                        </p>
                      </div>
                    </div>
                    <pre className="mt-3 rounded-xl bg-base-200 p-3 text-xs overflow-x-auto whitespace-pre-wrap">
                      {JSON.stringify(event.payload, null, 2)}
                    </pre>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-base-content/70">No events are recorded for this item.</p>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-[0.18em] text-base-content/50 mb-1">{label}</p>
      <p className="break-words">{value}</p>
    </div>
  );
}

function formatDate(value: string | Date | null, includeTime = true) {
  if (!value) return "—";

  const date = new Date(value);
  return includeTime ? date.toLocaleString() : date.toLocaleDateString();
}
