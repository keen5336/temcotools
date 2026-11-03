import { requireCapability } from "@/lib/auth";
import WorkflowClient from "./WorkflowClient";
export default async function WorkflowPage() {
  const session = await requireCapability("workflow.read");
  return <main className="max-w-5xl mx-auto p-4"><WorkflowClient siteId={session.siteId!} siteName={session.siteName ?? "Current warehouse"} canManage={session.capabilities?.includes("workflows.manage") === true} /></main>;
}
