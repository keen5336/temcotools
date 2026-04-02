import { requireAuth } from "@/lib/auth";
import NavBar from "@/components/NavBar";

export default async function RtvLabelPage() {
  const session = await requireAuth();

  return (
    <div className="min-h-screen bg-gray-50">
      <NavBar session={session} />
      <main className="max-w-4xl mx-auto px-4 py-10">
        <h1 className="text-2xl font-semibold text-gray-900 mb-2">RTV Label Tool</h1>
        <p className="text-gray-500 mb-8">Generate and print return-to-vendor shipping labels.</p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-white border border-gray-200 rounded-lg p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-4">Label Generation</h2>
            <p className="text-sm text-gray-400">
              Label generation interface will be implemented here.
            </p>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-4">Printer Configuration</h2>
            <p className="text-sm text-gray-400">
              Printer selection and configuration will be implemented here.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
