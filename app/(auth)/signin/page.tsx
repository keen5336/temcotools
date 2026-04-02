import { getSession } from "@/lib/auth";
import { redirect } from "next/navigation";
import PinLoginForm from "@/components/PinLoginForm";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getSession();
  if (session.userId) redirect("/");

  const params = await searchParams;

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 w-full max-w-sm">
        <h1 className="text-xl font-semibold text-gray-900 mb-1">TemcoTools</h1>
        <p className="text-sm text-gray-500 mb-8">Internal operations system</p>

        {params.error === "inactive" && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
            Your account has been deactivated. Contact an administrator.
          </div>
        )}

        <PinLoginForm />
      </div>
    </div>
  );
}

