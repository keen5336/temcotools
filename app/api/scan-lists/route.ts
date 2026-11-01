import { getCurrentPrincipal } from "@/lib/auth";
import { createScanList, listScanLists } from "@/lib/application/retained-lists";
import { readRetainedJson, retainedFailure, retainedReply } from "@/lib/application/retained-http";
export const runtime = "nodejs";
export async function GET() { try { const principal = await getCurrentPrincipal(); return principal ? retainedReply({ ok: true, scanLists: await listScanLists(principal) }) : retainedReply({ ok: false, error: "Sign in required." }, 401); } catch (error) { return retainedFailure(error); } }
export async function POST(request: Request) { try { const principal = await getCurrentPrincipal(); return principal ? retainedReply({ ok: true, scanList: await createScanList(principal, await readRetainedJson(request)) }) : retainedReply({ ok: false, error: "Sign in required." }, 401); } catch (error) { return retainedFailure(error); } }
