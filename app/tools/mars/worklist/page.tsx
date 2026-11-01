import NavBar from "@/components/NavBar";
import MarsNav from "@/components/mars/MarsNav";
import MarsSubmissionWorklist from "@/components/mars/MarsSubmissionWorklist";
import { requireCapability } from "@/lib/auth";

export default async function MarsWorklistPage() {
  const session = await requireCapability("workflow.read");
  return <div className="min-h-screen bg-base-200"><NavBar session={session} /><main className="max-w-3xl mx-auto p-4 space-y-4"><h1 className="text-2xl font-bold">Returns and MARS submission work</h1><MarsNav /><p>Identify the physical unit, review its office authority and retain the human submission trail. Preparation, external submission, printing and pickup are separate facts.</p><MarsSubmissionWorklist currentUserId={session.userId!} canExecute={Boolean(session.capabilities?.includes("workflow.execute"))} canAuthorize={Boolean(session.capabilities?.includes("office.authorize_rtv"))} /></main></div>;
}
