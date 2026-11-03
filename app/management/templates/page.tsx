import { requireAuth } from "@/lib/auth";
import TemplatesClient from "./TemplatesClient";

export default async function TemplatesPage() {
  await requireAuth();
  return <TemplatesClient />;
}
