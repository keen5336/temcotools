import { safeReturnTo } from "@/lib/mcp/config";
import { getSession } from "@/lib/auth";
import AccountUpdateClient from "@/components/account/AccountUpdateClient";

export default async function AccountUpdatePage({ searchParams }: { searchParams: Promise<{ returnTo?: string }> }) {
  const session = await getSession();
  return <main className="min-h-screen bg-base-200 p-4 flex items-center justify-center"><section className="card bg-base-100 border border-base-300 w-full max-w-lg"><div className="card-body"><h1 className="card-title text-2xl">Let’s update your login</h1><AccountUpdateClient initialUsername={session.upgradeUsername || session.username} returnTo={safeReturnTo((await searchParams).returnTo)} /></div></section></main>;
}
