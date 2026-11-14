import NavBar from "@/components/NavBar";
import DriverPaperworkClient from "@/components/driver-paperwork/DriverPaperworkClient";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/db";

export default async function DriverPaperworkPage() {
  const session = await requireAuth();
  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { role: true, isActive: true } });
  const canEdit = !!user?.isActive && (user.role === "admin" || user.role === "manager");
  return <div className="min-h-screen bg-base-200">
    <NavBar session={session} />
    <main className="max-w-5xl mx-auto px-4 py-8"><DriverPaperworkClient canEdit={canEdit} /></main>
  </div>;
}
