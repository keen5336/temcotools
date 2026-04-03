import { requireAuth } from "@/lib/auth";
import NavBar from "@/components/NavBar";
import PipelineBuilderClient from "./PipelineBuilderClient";

export default async function ReportEnginePage() {
  const session = await requireAuth();

  return (
    <div className="min-h-screen bg-base-200">
      <NavBar session={session} />
      <main className="max-w-5xl mx-auto px-4 py-10">
        <h1 className="text-2xl font-semibold text-base-content mb-2 print:hidden">
          Report Engine
        </h1>
        <p className="text-base-content/70 mb-8 print:hidden">
          Build data transformation pipelines on CSV files and export formatted
          reports.
        </p>
        <PipelineBuilderClient />
      </main>
    </div>
  );
}
