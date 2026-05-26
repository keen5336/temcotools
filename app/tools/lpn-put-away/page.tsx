import { requireAuth } from "@/lib/auth";
import NavBar from "@/components/NavBar";
import LpnPutAwayClient from "./LpnPutAwayClient";

export default async function LpnPutAwayPage() {
  const session = await requireAuth();

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-screen-xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-semibold text-base-content mb-1">
          LPN Put Away
        </h1>
        <p className="text-base-content/70 mb-6">
          Upload the LPN report, choose a received date, and pull the Placing
          list for put away.
        </p>
        <LpnPutAwayClient />
      </main>
    </div>
  );
}
