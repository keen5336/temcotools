import { requireAdmin } from "@/lib/auth";
import NavBar from "@/components/NavBar";
import AdminFileManagerClient from "@/components/AdminFileManagerClient";

export default async function AdminFilesPage() {
  const session = await requireAdmin();

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-6xl mx-auto px-4 py-10">
        <h1 className="text-2xl font-semibold text-base-content mb-2">Admin File Manager</h1>
        <p className="text-base-content/70 mb-6">
          Simple shared swap space for uploads, downloads, and temporary file exchange.
        </p>
        <AdminFileManagerClient />
      </main>
    </div>
  );
}

