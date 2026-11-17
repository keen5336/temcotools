import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

import { authenticateAccessToken } from "@/lib/mcp/oauth";

export async function GET(request: Request) {
  const bearer = request.headers.get("authorization");
  let session;
  if (bearer) {
    try { const principal = await authenticateAccessToken(bearer.startsWith("Bearer ") ? bearer.slice(7) : ""); if (!principal.grant.scopes.includes("temco.write")) return NextResponse.json({ error: "Printing requires write access." }, { status: 403 }); session = principal.actor; }
    catch { return NextResponse.json({ error: "Sign in to use label relay." }, { status: 401 }); }
  } else session = await getSession();
  const user = session.userId && session.isActive
    ? await prisma.user.findUnique({ where: { id: session.userId }, select: { id: true, isActive: true } })
    : null;
  if (!user?.isActive) return NextResponse.json({ error: "Sign in to use label relay." }, { status: 401 });
  const printers = await prisma.labelPrinter.findMany({
    where: { isActive: true },
    select: { id: true, name: true, endpoint: true, contentType: true },
    orderBy: { name: "asc" },
  });
  return NextResponse.json({ userId: user.id, printers, kind: bearer ? "mcp" : "browser", sessionId: session.sessionId }, { headers: { "Cache-Control": "no-store" } });
}
