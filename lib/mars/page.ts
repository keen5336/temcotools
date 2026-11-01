import { redirect } from "next/navigation";
import { getCurrentPrincipal, requireCapability } from "@/lib/auth";

export async function requireMarsPage() {
  const session = await requireCapability("workflow.read");
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/signin");
  return { session, principal };
}
