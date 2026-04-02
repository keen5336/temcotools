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
    <div className="min-h-screen bg-base-200 flex items-center justify-center p-4">
      <div className="card bg-base-100 shadow-sm border border-base-200 w-full max-w-sm">
        <div className="card-body">
          <h1 className="card-title text-xl">TemcoTools</h1>
          <p className="text-sm text-base-content/60 -mt-2 mb-4">Internal operations system</p>

          {params.error === "inactive" && (
            <div role="alert" className="alert alert-error text-sm mb-2">
              Your account has been deactivated. Contact an administrator.
            </div>
          )}

          <PinLoginForm />
        </div>
      </div>
    </div>
  );
}

