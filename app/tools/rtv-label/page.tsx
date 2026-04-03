import { requireAuth } from "@/lib/auth";
import NavBar from "@/components/NavBar";
import MarsLabelClient from "./MarsLabelClient";

export default async function MarsLabelPage() {
  const session = await requireAuth();

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-screen-xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-semibold text-base-content mb-1">MARS Label Tool</h1>
        <p className="text-base-content/70 mb-6">
          Paste the full return page text, extract the fields automatically, preview the label,
          and print straight to a networked label printer. Includes editable ZPL templates stored
          in local storage.
        </p>
        <MarsLabelClient />
      </main>
    </div>
  );
}
