import { requireAdmin } from "@/lib/auth";
import NavBar from "@/components/NavBar";
import AdminUsersClient from "@/components/AdminUsersClient";

export default async function AdminUsersPage() {
  const session = await requireAdmin();

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-5xl mx-auto px-4 py-10">
        <h1 className="text-2xl font-semibold text-base-content mb-6">
          User Management
        </h1>
        <AdminUsersClient />
      </main>
    </div>
  );
}
