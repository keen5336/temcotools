import Link from "next/link";
import NavBar from "@/components/NavBar";
import MarsNav from "@/components/mars/MarsNav";
import { requireAuth } from "@/lib/auth";
import { getMarsOperationalOverview } from "@/lib/mars/inventory";

const sections = [
  {
    href: "/tools/mars/inventory",
    name: "Inventory",
    featured: true,
  },
  {
    href: "/tools/mars/import",
    name: "Import",
  },
  {
    href: "/tools/mars/audit",
    name: "Audit",
  },
  {
    href: "/tools/mars/reconciliation",
    name: "Reconciliation",
  },
];

export default async function MarsPage() {
  const session = await requireAuth();
  const overview = await getMarsOperationalOverview();

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-semibold text-base-content mb-6">MARS Tracking</h1>
        <MarsNav />

        <section className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
          <MetricCard label="Active In MARS" value={overview.summary.activeUnits} tone="default" />
          <MetricCard label="Needs Audit Review" value={overview.summary.notSeenInAudit} tone="warning" />
          <MetricCard label="Missing From Latest Import" value={overview.summary.missingFromLatestImport} tone="error" />
          <MetricCard label="Staged" value={overview.summary.stagedUnits} tone="info" />
          <MetricCard label="Shipped / Received" value={overview.summary.shippedOrReceived} tone="warning" />
          <MetricCard label="Archived" value={overview.summary.archivedUnits} tone="default" />
        </section>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {sections.map((section) => (
            <Link
              key={section.href}
              href={section.href}
              className={`block rounded-xl border border-base-200 bg-base-100 p-5 shadow-sm transition hover:border-primary ${
                section.featured ? "md:col-span-2" : ""
              }`}
            >
              <h2 className="text-lg font-semibold text-base-content">{section.name}</h2>
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
