import ScannerDiagnosticClient from "@/components/admin/ScannerDiagnosticClient";
import { requireAdmin } from "@/lib/auth";

export default async function ScannerDiagnosticPage() {
  await requireAdmin();

  return <ScannerDiagnosticClient />;
}
