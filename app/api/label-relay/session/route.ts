import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function GET() {
  const session = await getSession();
  const user = session.userId && session.isActive
    ? await prisma.user.findUnique({ where: { id: session.userId }, select: { id: true, isActive: true } })
    : null;
  if (!user?.isActive) return NextResponse.json({ error: "Sign in to use label relay." }, { status: 401 });
  const printers = await prisma.labelPrinter.findMany({
    where: { isActive: true },
    select: { id: true, name: true, endpoint: true, contentType: true },
    orderBy: { name: "asc" },
  });
  return NextResponse.json({ userId: user.id, printers }, { headers: { "Cache-Control": "no-store" } });
}
