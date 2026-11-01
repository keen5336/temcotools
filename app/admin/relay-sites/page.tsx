import { redirect } from "next/navigation";
import { requireCapability } from "@/lib/auth";
import NavBar from "@/components/NavBar";
import SiteProfilesClient from "@/components/relay-sites/SiteProfilesClient";
export default async function SiteProfilesPage() {
  const session = await requireCapability("payloads.manage");
  if (session.role !== "admin") redirect("/");
  return <div className="min-h-screen bg-base-200"><NavBar session={session} /><main className="max-w-5xl mx-auto p-4 sm:p-6"><SiteProfilesClient /></main></div>;
}
