import NavBar from "@/components/NavBar";
import DispatchWorkspaceClient from "@/components/dispatch/DispatchWorkspaceClient";
import { getPrincipal, requireCapability } from "@/lib/auth";
export default async function DispatchPage() {
  const session = await requireCapability("workflow.read"); const principal = await getPrincipal();
  const has = (capability: string) => Boolean(principal?.capabilities.some((item) => item === capability));
  return <div className="min-h-screen bg-base-200"><NavBar session={session} /><main className="mx-auto max-w-5xl px-3 py-6 sm:px-6"><DispatchWorkspaceClient userId={session.userId} canDecide={has("office.decide")} canAllocate={has("dispatch.allocate")} canSignoff={has("dispatch.signoff")} canExecute={has("workflow.execute")} /></main></div>;
}
