import { getSession } from "@/lib/auth";
import { managedUserDevices, revokeManagedDevice } from "@/lib/auth/admin";
import { authFailure, authReply, readAuthBody, sameOrigin } from "@/lib/auth/context";
import { AuthError } from "@/lib/auth/policy";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { return authReply(await managedUserDevices(await getSession(), (await params).id)); } catch (error) { return authFailure(error); }
}
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    sameOrigin(request); const body = await readAuthBody(request);
    if (typeof body.sessionId !== "string" || !body.sessionId || body.sessionId.length > 200) throw new AuthError("Select a device.");
    return authReply(await revokeManagedDevice(await getSession(), (await params).id, body.sessionId));
  } catch (error) { return authFailure(error); }
}
