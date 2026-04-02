import { requireAdmin } from "@/lib/auth";
import NavBar from "@/components/NavBar";
import AdminUsersClient from "@/components/AdminUsersClient";

export default async function AdminUsersPage() {
  const session = await requireAdmin();

  return (
    <div className="min-h-screen bg-gray-50">
      <NavBar session={session} />
      <main className="max-w-5xl mx-auto px-4 py-10">
        <h1 className="text-2xl font-semibold text-gray-900 mb-6">
          User Management
        </h1>
        <AdminUsersClient />
      </main>
    </div>
  );
}
