import MarsInventoryClient from "@/components/mars/MarsInventoryClient";
import MarsNav from "@/components/mars/MarsNav";
import type {
  getMarsOperationalOverview,
  listMarsUnits,
} from "@/lib/mars/inventory";

type MarsInventoryScreenProps = {
  initialResponse: Awaited<ReturnType<typeof listMarsUnits>>;
  overview: Awaited<ReturnType<typeof getMarsOperationalOverview>>;
};

export default function MarsInventoryScreen({
  initialResponse,
  overview,
}: MarsInventoryScreenProps) {
  return (
    <>
      <h1 className="text-2xl font-semibold text-base-content mb-4">MARS Inventory</h1>
      <MarsNav />
      <section className="grid grid-cols-2 lg:grid-cols-5 gap-2 mb-4">
        <Metric label="Active In MARS" value={overview.summary.activeUnits} tone="default" />
        <Metric label="Needs Audit Review" value={overview.summary.notSeenInAudit} tone="warning" />
        <Metric label="Staged" value={overview.summary.stagedUnits} tone="info" />
        <Metric label="Shipped / Received" value={overview.summary.shippedOrReceived} tone="warning" />
        <Metric label="Archived" value={overview.summary.archivedUnits} tone="default" />
      </section>
      <MarsInventoryClient initialResponse={{ ok: true, ...initialResponse }} />
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
