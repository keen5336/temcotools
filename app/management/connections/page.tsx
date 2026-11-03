import { requireAuth } from "@/lib/auth";
import ConnectionsClient from "./ConnectionsClient";
export default async function ConnectionsPage() {
  await requireAuth();
  return <main className="max-w-5xl mx-auto p-4"><ConnectionsClient /></main>;
}
