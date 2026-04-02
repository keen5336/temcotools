import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import bcrypt from "bcryptjs";

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
  await requireAdmin();
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  const { username, displayName, pin, role } = body as {
    username?: string;
    displayName?: string;
    pin?: string;
    role?: string;
  };

  if (!username?.trim()) {
    return NextResponse.json({ error: "Username is required." }, { status: 400 });
  }
  if (!displayName?.trim()) {
    return NextResponse.json({ error: "Display name is required." }, { status: 400 });
  }
  if (!pin || !/^\d{4,6}$/.test(pin)) {
    return NextResponse.json({ error: "PIN must be 4 to 6 digits." }, { status: 400 });
  }
  if (role && role !== "admin" && role !== "user") {
    return NextResponse.json({ error: "Invalid role." }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { username: username.trim() } });
  if (existing) {
    return NextResponse.json({ error: "Username already exists." }, { status: 409 });
  }

  const pinHash = await bcrypt.hash(pin, 12);
  const user = await prisma.user.create({
    data: {
      username: username.trim(),
      displayName: displayName.trim(),
      pinHash,
      role: (role as "admin" | "user") ?? "user",
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

  return NextResponse.json(user, { status: 201 });
}

