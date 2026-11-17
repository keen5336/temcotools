import { redirect } from "next/navigation";
import { requireManager } from "@/lib/auth";

export default async function LabelConfigurationPage() {
  await requireManager();
  redirect("/configuration#labels");
}
