import { requireAuth } from "@/lib/auth";
import NavBar from "@/components/NavBar";
import Link from "next/link";

export default async function HomePage() {
  const session = await requireAuth();

  const tools = [
    {
      name: "MARS Label Tool",
      href: "/tools/rtv-label",
      description: "Generate and print MARS return shipping labels.",
    },
    {
      name: "Report Engine",
      href: "/tools/report-engine",
      description:
        "Build data transformation pipelines on CSV files and export formatted reports.",
    },
    {
      name: "Barcode Generator",
      href: "/tools/barcode-generator",
      description: "Paste a list of values to generate and print a batch of barcodes.",
    },
  ];

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-5xl mx-auto px-4 py-10">
        <h1 className="text-2xl font-semibold text-base-content mb-2">
          Operations Tools
        </h1>
        <p className="text-base-content/70 mb-8">Select a tool to get started.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {tools.map((tool) => (
            <Link
              key={tool.href}
              href={tool.href}
              className="block bg-base-100 border border-base-200 rounded-lg p-5 hover:border-primary hover:shadow-sm transition"
            >
              <h2 className="text-base font-semibold text-base-content mb-1">
                {tool.name}
              </h2>
              <p className="text-sm text-base-content/70">{tool.description}</p>
            </Link>
          ))}
          {session.role === "admin" && (
            <Link
              href="/admin/users"
              className="block bg-base-100 border border-base-200 rounded-lg p-5 hover:border-primary hover:shadow-sm transition"
            >
              <h2 className="text-base font-semibold text-base-content mb-1">
                User Management
              </h2>
              <p className="text-sm text-base-content/70">Manage users, roles, and access.</p>
            </Link>
          )}
        </div>
      </main>
    </div>
  );
}
