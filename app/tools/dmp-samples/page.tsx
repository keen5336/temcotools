import NavBar from "@/components/NavBar";
import DmpSamplesClient from "@/components/dmp/DmpSamplesClient";
import { requireCapability } from "@/lib/auth";

export default async function DmpSamplesPage() {
  const session = await requireCapability("workflow.read");
  return <div className="min-h-screen bg-base-200"><NavBar session={session} /><main className="mx-auto max-w-4xl px-3 py-6 sm:px-6"><DmpSamplesClient /></main></div>;
}
