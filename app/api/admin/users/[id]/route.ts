import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import bcrypt from "bcryptjs";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await requireAdmin();
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  const { username, displayName, pin, role, isActive } = body as {
    username?: string;
    displayName?: string;
    pin?: string;
    role?: string;
    isActive?: boolean;
  };

  if (username !== undefined && !username.trim()) {
    return NextResponse.json({ error: "Username cannot be empty." }, { status: 400 });
  }
  if (displayName !== undefined && !displayName.trim()) {
    return NextResponse.json({ error: "Display name cannot be empty." }, { status: 400 });
  }
  if (pin !== undefined && !/^\d{4,6}$/.test(pin)) {
    return NextResponse.json({ error: "PIN must be 4 to 6 digits." }, { status: 400 });
  }
  if (role !== undefined && role !== "admin" && role !== "user") {
    return NextResponse.json({ error: "Invalid role." }, { status: 400 });
  }

  if (username) {
    const conflict = await prisma.user.findFirst({
      where: { username: username.trim(), NOT: { id } },
    });
    if (conflict) {
      return NextResponse.json({ error: "Username already exists." }, { status: 409 });
    }
  }

  const data: Record<string, unknown> = {};
  if (username !== undefined) data.username = username.trim();
  if (displayName !== undefined) data.displayName = displayName.trim();
  if (pin !== undefined) data.pinHash = await bcrypt.hash(pin, 12);
  if (role !== undefined) data.role = role;
  if (isActive !== undefined) data.isActive = isActive;

  const updated = await prisma.user.update({
    where: { id },
    data,
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

  return NextResponse.json(updated);
}

