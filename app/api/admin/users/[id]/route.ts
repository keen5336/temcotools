import { getSession } from "@/lib/auth";
import { authFailure, authReply, readAuthBody, sameOrigin } from "@/lib/auth/context";
import { updateManagedUser } from "@/lib/auth/admin";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { sameOrigin(request); return authReply(await updateManagedUser(await getSession(), (await params).id, await readAuthBody(request))); } catch (error) { return authFailure(error); }
}
