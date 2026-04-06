import { requireAuth } from "@/lib/auth";
import NavBar from "@/components/NavBar";
import BarcodeGeneratorClient from "./BarcodeGeneratorClient";

export default async function BarcodeGeneratorPage() {
  const session = await requireAuth();

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-screen-xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-semibold text-base-content mb-1">Barcode Generator</h1>
        <p className="text-base-content/70 mb-6">
          Paste a list of values (one per line) to generate a batch of barcodes ready to print.
        </p>
        <BarcodeGeneratorClient />
      </main>
    </div>
  );
}
