import { NextRequest, NextResponse } from "next/server";
import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { sessionOptions, type SessionData } from "@/lib/session";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.username !== "string" || typeof body.pin !== "string") {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const { username, pin } = body as { username: string; pin: string };

  const user = await prisma.user.findUnique({ where: { username } });

  if (!user) {
    return NextResponse.json({ error: "Invalid username or PIN." }, { status: 401 });
  }

  if (!user.isActive) {
    return NextResponse.json(
      { error: "Account is deactivated. Contact an administrator." },
      { status: 403 }
    );
  }

  const pinValid = await bcrypt.compare(pin, user.pinHash);
  if (!pinValid) {
    return NextResponse.json({ error: "Invalid username or PIN." }, { status: 401 });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  const cookieStore = await cookies();
  const session = await getIronSession<SessionData>(cookieStore, sessionOptions);
  session.userId = user.id;
  session.username = user.username;
  session.displayName = user.displayName;
  session.role = user.role;
  session.isActive = user.isActive;
  await session.save();

  return NextResponse.json({ ok: true });
}
