import { requirePlatformAdmin } from "@/lib/auth/platform";
import ScanLabClient from "@/components/scan-lab/ScanLabClient";
export default async function ScanLabPage() {
  await requirePlatformAdmin();
  return <ScanLabClient />;
}
