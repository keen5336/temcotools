import NavBar from "@/components/NavBar";
import OfficeWorkspaceClient from "@/components/office/OfficeWorkspaceClient";
import { getPrincipal, requireCapability } from "@/lib/auth";

export default async function OfficeWorkspacePage() {
  const session = await requireCapability("workflow.read");
  const principal = await getPrincipal();
  const has = (capability: string) => Boolean(principal?.capabilities.some((item) => item === capability));
  return <div className="min-h-screen bg-base-200"><NavBar session={session} /><main className="mx-auto max-w-5xl px-3 py-6 sm:px-6"><OfficeWorkspaceClient userId={session.userId} canDecide={has("office.decide")} canAuthorizeRtv={has("office.authorize_rtv")} canExecute={has("workflow.execute")} canEvaluate={has("office.decide") || has("inventory.write")} /></main></div>;
}
