import Link from "next/link";
import NavBar from "@/components/NavBar";
import MarsNav from "@/components/mars/MarsNav";
import { requireAuth } from "@/lib/auth";

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

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-semibold text-base-content mb-1">MARS Tracking</h1>
        <p className="text-base-content/70 mb-6">
          MARS remains the authority system. TemcoTools handles local operational state, audit
          capture, and discrepancy visibility.
        </p>
        <MarsNav />

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
