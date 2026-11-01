import { getCurrentPrincipal } from "@/lib/auth";
import { downloadAdminFile } from "@/lib/admin-file-service";
import { adminFileFailure, adminFileReply } from "@/lib/admin-file-http";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const principal = await getCurrentPrincipal(); if (!principal) return adminFileReply({ error: "Sign in required." }, 401);
    const file = await downloadAdminFile(principal, { path: new URL(request.url).searchParams.get("path") ?? "" });
    const fallback = file.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    return new Response(Buffer.from(file.contentBase64, "base64"), { headers: { "Content-Type": file.contentType, "Content-Length": String(file.size), "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return adminFileFailure(error); }
}
