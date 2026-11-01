import { getCurrentPrincipal } from "@/lib/auth";
import { previewRouteRecon } from "@/lib/application/retained-lists";
import { readRetainedWorkbookForm, retainedFailure, retainedReply } from "@/lib/application/retained-http";
export const runtime = "nodejs";
export async function POST(request: Request) { try { const principal = await getCurrentPrincipal(); if (!principal) return retainedReply({ ok: false, error: "Sign in required." }, 401); const { upload } = await readRetainedWorkbookForm(request); return retainedReply({ ok: true, preview: await previewRouteRecon(principal, { contentBase64: Buffer.from(await upload.arrayBuffer()).toString("base64") }) }); } catch (error) { return retainedFailure(error); } }
