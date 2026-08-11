import NavBar from "@/components/NavBar";
import LabelConfigurationClient from "@/components/labels/LabelConfigurationClient";
import { requireManager } from "@/lib/auth";

export default async function LabelConfigurationPage() {
  const session = await requireManager();
  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="text-2xl font-semibold">Label Configuration</h1>
        <p className="mt-2 mb-6 text-base-content/65">
          Manage the shared printer destinations and workflow-specific ZPL templates available to operators.
        </p>
        <LabelConfigurationClient />
      </main>
    </div>
  );
}
