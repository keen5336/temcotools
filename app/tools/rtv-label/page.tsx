import { requireAuth } from "@/lib/auth";
import NavBar from "@/components/NavBar";

export default async function RtvLabelPage() {
  const session = await requireAuth();

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-4xl mx-auto px-4 py-10">
        <h1 className="text-2xl font-semibold text-base-content mb-2">RTV Label Tool</h1>
        <p className="text-base-content/70 mb-8">Generate and print return-to-vendor shipping labels.</p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-base-100 border border-base-200 rounded-lg p-6">
            <h2 className="text-base font-semibold text-base-content mb-4">Label Generation</h2>
            <p className="text-sm text-base-content/50">
              Label generation interface will be implemented here.
            </p>
          </div>

          <div className="bg-base-100 border border-base-200 rounded-lg p-6">
            <h2 className="text-base font-semibold text-base-content mb-4">Printer Configuration</h2>
            <p className="text-sm text-base-content/50">
              Printer selection and configuration will be implemented here.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
