import { getCurrentPrincipal } from "@/lib/auth";
import { createAdminDirectory, deleteAdminFile, listAdminFiles, moveAdminFile, uploadAdminFiles } from "@/lib/admin-file-service";
import { MAX_ADMIN_FILE_BYTES, AdminFileError } from "@/lib/admin-files";
import { adminFileFailure, adminFileReply, readAdminJson, readAdminUploadForm } from "@/lib/admin-file-http";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { const principal = await getCurrentPrincipal(); return principal ? adminFileReply(await listAdminFiles(principal, { path: new URL(request.url).searchParams.get("path") ?? "" })) : adminFileReply({ error: "Sign in required." }, 401); } catch (error) { return adminFileFailure(error); }
}
export async function POST(request: Request) {
  try {
    const principal = await getCurrentPrincipal(); if (!principal) return adminFileReply({ error: "Sign in required." }, 401);
    const form = await readAdminUploadForm(request);
    const uploads = form.getAll("files").filter((value): value is File => value instanceof File);
    if (!uploads.length || uploads.length > 40 || uploads.some(file => file.size > MAX_ADMIN_FILE_BYTES)) throw new AdminFileError("Choose up to 40 files, each at most 64 MiB.", 413);
    let expected: Record<string,string> = {};
    try { expected = JSON.parse(String(form.get("expectedFingerprints") ?? "{}")); if (!expected || Array.isArray(expected) || typeof expected !== "object" || Object.values(expected).some(value => typeof value !== "string")) throw new Error(); } catch { throw new AdminFileError("Reload the current replacement versions."); }
    const files = await Promise.all(uploads.map(async file => ({ name: file.name, contentBase64: Buffer.from(await file.arrayBuffer()).toString("base64"), replace: form.get("replace") === "true" && Boolean(expected[file.name]), expectedFingerprint: expected[file.name] })));
    const receipt = await uploadAdminFiles(principal, { operationId: String(form.get("operationId") ?? ""), path: String(form.get("path") ?? ""), files });
    return adminFileReply(receipt, receipt.ok ? 200 : 409);
  } catch (error) { return adminFileFailure(error); }
}
export async function PUT(request: Request) {
  try { const principal = await getCurrentPrincipal(); if (!principal) return adminFileReply({ error: "Sign in required." }, 401); const receipt = await createAdminDirectory(principal, await readAdminJson(request)); return adminFileReply(receipt, receipt.ok ? 200 : 409); } catch (error) { return adminFileFailure(error); }
}
export async function PATCH(request: Request) {
  try { const principal = await getCurrentPrincipal(); if (!principal) return adminFileReply({ error: "Sign in required." }, 401); const receipt = await moveAdminFile(principal, await readAdminJson(request)); return adminFileReply(receipt, receipt.ok ? 200 : 409); } catch (error) { return adminFileFailure(error); }
}
export async function DELETE(request: Request) {
  try { const principal = await getCurrentPrincipal(); if (!principal) return adminFileReply({ error: "Sign in required." }, 401); const params = new URL(request.url).searchParams; const receipt = await deleteAdminFile(principal, { operationId: params.get("operationId"), path: params.get("path"), expectedFingerprint: params.get("expectedFingerprint") }); return adminFileReply(receipt, receipt.ok ? 200 : 409); } catch (error) { return adminFileFailure(error); }
}
