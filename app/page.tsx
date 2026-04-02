import { requireAuth } from "@/lib/auth";
import NavBar from "@/components/NavBar";
import Link from "next/link";

export default async function HomePage() {
  const session = await requireAuth();

  const tools = [
    {
      name: "RTV Label Tool",
      href: "/tools/rtv-label",
      description: "Generate and print RTV shipping labels.",
    },
    {
      name: "Receiving Reconcile",
      href: "/tools/receiving-reconcile",
      description: "Reconcile receiving documents against purchase orders.",
    },
    {
      name: "Scanner Lookup",
      href: "/tools/scanner-lookup",
      description: "Look up items and locations by barcode scan.",
    },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <NavBar session={session} />
      <main className="max-w-5xl mx-auto px-4 py-10">
        <h1 className="text-2xl font-semibold text-gray-900 mb-2">
          Operations Tools
        </h1>
        <p className="text-gray-500 mb-8">Select a tool to get started.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {tools.map((tool) => (
            <Link
              key={tool.href}
              href={tool.href}
              className="block bg-white border border-gray-200 rounded-lg p-5 hover:border-blue-400 hover:shadow-sm transition"
            >
              <h2 className="text-base font-semibold text-gray-900 mb-1">
                {tool.name}
              </h2>
              <p className="text-sm text-gray-500">{tool.description}</p>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
