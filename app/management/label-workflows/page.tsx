import { requireCapability } from "@/lib/auth";
import NavBar from "@/components/NavBar";
import LabelWorkflowsClient from "@/components/labels/LabelWorkflowsClient";
export default async function LabelWorkflowsPage() {
  const session = await requireCapability("labels.manage");
  return <div className="min-h-screen bg-base-200"><NavBar session={session} /><main className="max-w-6xl mx-auto p-4"><LabelWorkflowsClient /></main></div>;
}
