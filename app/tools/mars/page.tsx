import Link from "next/link";
import NavBar from "@/components/NavBar";
import MarsNav from "@/components/mars/MarsNav";
import { requireAuth } from "@/lib/auth";
import { getMarsOperationalOverview } from "@/lib/mars/inventory";

const sections = [
  {
    href: "/tools/mars/import",
    name: "Import",
    description: "Upload the latest MARS spreadsheet and review batch results.",
  },
  {
    href: "/tools/mars/inventory",
    name: "Inventory",
    description: "Browse imported units, search the current snapshot, and manage staged flags.",
  },
  {
    href: "/tools/mars/audit",
    name: "Audit",
    description: "Run scanner-first warehouse audits against current MARS units.",
  },
  {
    href: "/tools/mars/reconciliation",
    name: "Reconciliation",
    description: "Review strict-mode discrepancy buckets against the latest import and audit.",
  },
];

export default async function MarsPage() {
  const session = await requireAuth();
  const overview = await getMarsOperationalOverview();

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-semibold text-base-content mb-1">MARS Tracking</h1>
        <p className="text-base-content/70 mb-6">
          MARS remains the authority system. TemcoTools keeps the latest MARS snapshot visible,
          lets us amend audit sessions, and surfaces the units that need attention.
        </p>
        <MarsNav />

        <section className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
          <MetricCard label="Active In MARS" value={overview.summary.activeUnits} tone="default" />
          <MetricCard label="Needs Audit Review" value={overview.summary.notSeenInAudit} tone="warning" />
          <MetricCard label="Missing From Latest Import" value={overview.summary.missingFromLatestImport} tone="error" />
          <MetricCard label="Staged" value={overview.summary.stagedUnits} tone="info" />
          <MetricCard label="Shipped / Received" value={overview.summary.shippedOrReceived} tone="warning" />
          <MetricCard label="Archived" value={overview.summary.archivedUnits} tone="default" />
        </section>

        <section className="card bg-base-100 border border-base-200 shadow-sm mb-6">
          <div className="card-body">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="card-title">Current Operational View</h2>
                <p className="text-sm text-base-content/70">
                  Start from the latest MARS import, work in amendable audit sessions, and keep
                  the main inventory focused on active issues instead of historical noise.
                </p>
              </div>
              <Link href="/tools/mars/inventory" className="btn btn-sm btn-outline">
                Open Working Inventory
              </Link>
            </div>

            {overview.recentProblems.length ? (
              <div className="overflow-x-auto">
                <table className="table table-zebra">
                  <thead>
                    <tr>
                      <th>Request #</th>
                      <th>Order</th>
                      <th>Vendor</th>
                      <th>Model</th>
                      <th>Return Status</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.recentProblems.map((unit: (typeof overview.recentProblems)[number]) => (
                      <tr key={unit.requestNumber}>
                        <td>
                          <Link
                            href={`/tools/mars/inventory/${encodeURIComponent(unit.requestNumber)}`}
                            className="link link-primary font-medium"
                          >
                            {unit.requestNumber}
                          </Link>
                        </td>
                        <td>{unit.orderNumber ?? "—"}</td>
                        <td>{unit.vendor ?? "—"}</td>
                        <td>{unit.modelNumber ?? "—"}</td>
                        <td>{unit.returnStatus ?? "—"}</td>
                        <td className="max-w-md whitespace-normal">{unit.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-base-content/60">
                No active problem units surfaced right now.
              </p>
            )}
          </div>
        </section>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {sections.map((section) => (
            <Link
              key={section.href}
              href={section.href}
              className="block rounded-xl border border-base-200 bg-base-100 p-5 shadow-sm transition hover:border-primary"
            >
              <h2 className="text-lg font-semibold text-base-content mb-2">{section.name}</h2>
              <p className="text-sm text-base-content/70">{section.description}</p>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}

function MetricCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "default" | "warning" | "error" | "info";
}) {
  const tones = {
    default: "border-base-200 bg-base-100",
    warning: "border-warning/30 bg-warning/10",
    error: "border-error/30 bg-error/10",
    info: "border-info/30 bg-info/10",
  };

  return (
    <div className={`rounded-2xl border p-4 ${tones[tone]}`}>
      <p className="text-xs uppercase tracking-wide text-base-content/60">{label}</p>
      <p className="text-3xl font-semibold text-base-content">{value}</p>
    </div>
  );
}
