import { getCurrentPrincipal } from "@/lib/auth";
import { listPrintingDevices, registerPrintingDevice, revokePrintingDevice } from "@/lib/labels/devices";
import { labelReply, labelFailure, readLabelBody } from "@/lib/labels/http";
export const runtime = "nodejs";
export async function GET() { try { const principal = await getCurrentPrincipal(); return principal ? labelReply({ devices: await listPrintingDevices(principal) }) : labelReply({ error: "Sign in required." }, 401); } catch (error) { return labelFailure(error); } }
export async function POST(request: Request) { try { const principal = await getCurrentPrincipal(); if (!principal) return labelReply({ error: "Sign in required." }, 401); return labelReply(await registerPrintingDevice(principal, await readLabelBody(request))); } catch (error) { return labelFailure(error); } }
export async function DELETE(request: Request) { try { const principal = await getCurrentPrincipal(); if (!principal) return labelReply({ error: "Sign in required." }, 401); return labelReply(await revokePrintingDevice(principal, new URL(request.url).searchParams.get("id") ?? "")); } catch (error) { return labelFailure(error); } }
