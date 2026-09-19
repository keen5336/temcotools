import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import NavBar from "@/components/NavBar";
import LabelRelayClient from "@/components/labels/LabelRelayClient";

export default async function LabelRelayPage() {
  const session = await requireAuth();
  const printers = await prisma.labelPrinter.findMany({ where: { isActive: true }, select: { id: true, name: true, endpoint: true, contentType: true }, orderBy: { name: "asc" } });
  return <div className="min-h-screen bg-base-200">
    <NavBar session={session} />
    <main className="max-w-3xl mx-auto px-4 py-8"><h1 className="text-2xl font-semibold mb-2">Label Relay Mode</h1><p className="text-base-content/70 mb-6">Use this laptop to print labels sent from scanners and other devices.</p><LabelRelayClient printers={printers} /></main>
  </div>;
}
