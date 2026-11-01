import ScannerDiagnosticClient from "@/components/admin/ScannerDiagnosticClient";
import { requireCapability } from "@/lib/auth";

export default async function ScannerDiagnosticPage() {
  await requireCapability("diagnostics.use");

  return <ScannerDiagnosticClient />;
}
