import { requireAuth } from "@/lib/auth";
import NavBar from "@/components/NavBar";
import ScannerInput from "@/components/ScannerInput";

export default async function ScannerLookupPage() {
  const session = await requireAuth();

  return (
    <div className="min-h-screen bg-gray-50">
      <NavBar session={session} />
      <main className="max-w-4xl mx-auto px-4 py-10">
        <h1 className="text-2xl font-semibold text-gray-900 mb-2">Scanner Lookup</h1>
        <p className="text-gray-500 mb-8">Look up items and locations by barcode scan.</p>
        <ScannerInput />
      </main>
    </div>
  );
}
