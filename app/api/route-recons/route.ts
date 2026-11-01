import { getCurrentPrincipal } from "@/lib/auth";
import { importRouteRecon, listRouteRecons } from "@/lib/application/retained-lists";
import { readRetainedWorkbookForm, retainedFailure, retainedReply } from "@/lib/application/retained-http";
export const runtime = "nodejs";
export async function GET() { try { const principal = await getCurrentPrincipal(); return principal ? retainedReply({ ok: true, routeRecons: await listRouteRecons(principal) }) : retainedReply({ ok: false, error: "Sign in required." }, 401); } catch (error) { return retainedFailure(error); } }
export async function POST(request: Request) {
  try { const principal = await getCurrentPrincipal(); if (!principal) return retainedReply({ ok: false, error: "Sign in required." }, 401); const { form, upload } = await readRetainedWorkbookForm(request); return retainedReply({ ok: true, routeRecon: await importRouteRecon(principal, { name: form.get("name"), filename: upload.name, operationId: form.get("operationId") ?? undefined, contentBase64: Buffer.from(await upload.arrayBuffer()).toString("base64") }) }); } catch (error) { return retainedFailure(error); }
}
