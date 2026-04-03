import { requireAuth } from "@/lib/auth";
import NavBar from "@/components/NavBar";

export default async function ReceivingReconcilePage() {
  const session = await requireAuth();

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-4xl mx-auto px-4 py-10">
        <h1 className="text-2xl font-semibold text-base-content mb-2">Receiving Reconcile</h1>
        <p className="text-base-content/70 mb-8">
          Reconcile receiving documents against purchase orders.
        </p>

        <div className="grid grid-cols-1 gap-6">
          <div className="bg-base-100 border border-base-200 rounded-lg p-6">
            <h2 className="text-base font-semibold text-base-content mb-4">Upload Document</h2>
            <div className="border-2 border-dashed border-base-300 rounded-lg p-8 text-center">
              <p className="text-sm text-base-content/50">
                File upload functionality will be implemented here.
              </p>
            </div>
          </div>

          <div className="bg-base-100 border border-base-200 rounded-lg p-6">
            <h2 className="text-base font-semibold text-base-content mb-4">Reconciliation Results</h2>
            <p className="text-sm text-base-content/50">
              Results will appear here after processing.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
