import { auth } from "@/auth";
import { redirect } from "next/navigation";

export async function requireAuth() {
  const session = await auth();
  if (!session?.user) {
    redirect("/signin");
  }
  if (!session.user.isActive) {
    redirect("/signin?error=inactive");
  }
  return session;
}

export async function requireAdmin() {
  const session = await requireAuth();
  if (session.user.role !== "admin") {
    redirect("/");
  }
  return session;
}
