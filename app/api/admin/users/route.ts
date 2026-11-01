import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import bcrypt from "bcryptjs";
import { lockCurrentAdmin } from "@/lib/auth/admin-write";
import { AuthorizationError } from "@/lib/auth/principal";

export async function GET(req: NextRequest) {
  await requireAdmin();
  const { searchParams } = new URL(req.url);
  const search = searchParams.get("search") || "";

  const users = await prisma.user.findMany({
    where: search
      ? {
          OR: [
            { username: { contains: search, mode: "insensitive" } },
            { displayName: { contains: search, mode: "insensitive" } },
          ],
        }
      : undefined,
    select: {
      id: true,
      username: true,
      displayName: true,
      role: true,
      isActive: true,
      lastLoginAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(users);
}

export async function POST(req: NextRequest) {
  const actor = await requireAdmin();
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  const { username, displayName, pin, role } = body as {
    username?: string;
    displayName?: string;
    pin?: string;
    role?: string;
  };

  if (typeof username !== "string" || !username.trim()) {
    return NextResponse.json({ error: "Username is required." }, { status: 400 });
  }
  if (typeof displayName !== "string" || !displayName.trim()) {
    return NextResponse.json({ error: "Display name is required." }, { status: 400 });
  }
  if (typeof pin !== "string" || !/^\d{4,6}$/.test(pin)) {
    return NextResponse.json({ error: "PIN must be 4 to 6 digits." }, { status: 400 });
  }
  if (role !== undefined && role !== "admin" && role !== "manager" && role !== "user") {
    return NextResponse.json({ error: "Invalid role." }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { username: username.trim() } });
  if (existing) {
    return NextResponse.json({ error: "Username already exists." }, { status: 409 });
  }

  const pinHash = await bcrypt.hash(pin, 12);
  try {
    const user = await prisma.$transaction(async (tx) => {
      await lockCurrentAdmin(tx, actor.userId, actor.authVersion!);
      return tx.user.create({
        data: {
          username: username.trim(),
          displayName: displayName.trim(),
          pinHash,
          role: (role as "admin" | "manager" | "user") ?? "user",
        },
        select: {
          id: true,
          username: true,
          displayName: true,
          role: true,
          isActive: true,
          lastLoginAt: true,
          createdAt: true,
        },
      });
    });

    return NextResponse.json(user, { status: 201 });
  } catch (error) {
    if (error instanceof AuthorizationError) return NextResponse.json({ error: error.message }, { status: 403 });
    throw error;
  }
}
