import { requireCapability } from "@/lib/auth";
import NavBar from "@/components/NavBar";
import SharedPutAwayClient from "@/components/warehouse/SharedPutAwayClient";

export default async function LpnPutAwayPage() {
  const session = await requireCapability("inventory.read");

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-screen-xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-semibold text-base-content mb-1">
          LPN Put Away
        </h1>
        <p className="text-base-content/70 mb-6">
          Choose a received date to view Placing rows from the shared WMS report.
          The original local-file workflow remains available as a fallback.
        </p>
        <SharedPutAwayClient />
      </main>
    </div>
  );
}
