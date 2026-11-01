import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/auth";
import AuthorizeClient from "./AuthorizeClient";

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<{ request?: string }> }) {
  const requestId = (await searchParams).request ?? "";
  const principal = await getCurrentPrincipal();
  if (!principal) redirect(`/signin?returnTo=${encodeURIComponent(`/account/authorize?request=${requestId}`)}`);
  return <main className="min-h-screen bg-base-200 p-4"><div className="max-w-2xl mx-auto space-y-4"><h1 className="text-2xl font-bold">Connected application access</h1><AuthorizeClient requestId={requestId} /></div></main>;
}
