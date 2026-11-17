import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { authFailure, authReply, readAuthBody, sameOrigin } from "@/lib/auth/context";
import { createManagedUser, listManagedUsers } from "@/lib/auth/admin";

export async function GET(request: NextRequest) {
  try { return authReply(await listManagedUsers(await getSession(), request.nextUrl.searchParams.get("search") || "")); } catch (error) { return authFailure(error); }
}
export async function POST(request: Request) {
  try { sameOrigin(request); return authReply(await createManagedUser(await getSession(), await readAuthBody(request))); } catch (error) { return authFailure(error); }
}
