import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { consentView } from "@/lib/mcp/oauth";
import McpConsentClient from "@/components/account/McpConsentClient";
export default async function McpAuthorizationPage({ searchParams }: { searchParams: Promise<{ requestId?: string }> }) {
  const { requestId = "" } = await searchParams;
  const actor = await getSession(), returnTo = `/account/mcp/authorize?requestId=${encodeURIComponent(requestId)}`;
  if (actor.upgradeRequired) redirect(`/account/update?returnTo=${encodeURIComponent(returnTo)}`);
  if (!actor.userId) redirect(`/signin?returnTo=${encodeURIComponent(returnTo)}`);
  let view: Awaited<ReturnType<typeof consentView>> | null = null;
  let problem = "";
  if (actor.role !== "admin") problem = "MCP is available only to administrators. Sign in with an administrator account to connect a client.";
  else {
    try { view = await consentView(actor, requestId); }
    catch (error) { problem = error instanceof Error && "status" in error ? error.message : "Authorization is unavailable. Start again from your MCP client."; }
  }
  const content = view ? <McpConsentClient request={view} /> : <p role="alert">{problem}</p>;
  return <main className="min-h-screen bg-base-200 p-4 flex items-center justify-center"><section className="card bg-base-100 w-full max-w-2xl"><div className="card-body"><h1 className="card-title text-2xl">Authorize TemcoTools MCP</h1>{content}</div></section></main>;
}
