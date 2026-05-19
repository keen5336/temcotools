import Link from "next/link";
import MarsInventoryClient from "@/components/mars/MarsInventoryClient";
import MarsNav from "@/components/mars/MarsNav";
import type {
  getMarsOperationalOverview,
  listMarsUnits,
} from "@/lib/mars/inventory";

type MarsInventoryScreenProps = {
  initialResponse: Awaited<ReturnType<typeof listMarsUnits>>;
  overview: Awaited<ReturnType<typeof getMarsOperationalOverview>>;
  initialState?: Parameters<typeof MarsInventoryClient>[0]["initialState"];
};

export default function MarsInventoryScreen({
  initialResponse,
  overview,
  initialState,
}: MarsInventoryScreenProps) {
  return (
    <>
      <h1 className="text-2xl font-semibold text-base-content mb-4">MARS Inventory</h1>
      <MarsNav />
      <section className="mb-5">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
          {overview.bucketCounts.map((bucket) => (
            <div
              key={bucket.bucket}
              className={`rounded-lg border bg-base-100 p-4 ${
                bucket.bucket === "problem" ? "border-error/40" : "border-base-200"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-base-content">{bucket.label}</p>
                  <p className="text-xs text-base-content/60 mt-1">{bucket.description}</p>
                </div>
                <p className="text-2xl font-semibold text-base-content">{bucket.count}</p>
              </div>
              <Link
                href={`/tools/mars/inventory?bucket=${bucket.bucket}&page=1&limit=50&sortBy=requestNumber&sortDirection=asc`}
                className="btn btn-sm btn-outline w-full mt-4"
              >
                View List
              </Link>
            </div>
          ))}
        </div>
      </section>
      <section className="grid grid-cols-2 lg:grid-cols-5 gap-2 mb-4">
        <Metric label="Active In MARS" value={overview.summary.activeUnits} tone="default" />
        <Metric label="Needs Audit Review" value={overview.summary.notSeenInAudit} tone="warning" />
        <Metric label="Staged" value={overview.summary.stagedUnits} tone="info" />
        <Metric label="Shipped / Received" value={overview.summary.shippedOrReceived} tone="warning" />
        <Metric label="Archived" value={overview.summary.archivedUnits} tone="default" />
      </section>
      <MarsInventoryClient initialResponse={{ ok: true, ...initialResponse }} initialState={initialState} />
    </>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "default" | "warning" | "info";
}) {
  const tones = {
    default: "border-base-200 bg-base-100",
    warning: "border-warning/30 bg-warning/10",
    info: "border-info/30 bg-info/10",
  };

  return (
    <div className={`rounded-lg border px-3 py-2 ${tones[tone]}`}>
      <p className="text-[0.65rem] uppercase text-base-content/60">{label}</p>
      <p className="text-xl font-semibold text-base-content">{value}</p>
    </div>
  );
}
