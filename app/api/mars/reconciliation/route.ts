import { marsApi } from "@/lib/mars/http";
import { reconcileMarsInventory } from "@/lib/mars/service";
export const runtime = "nodejs";
export async function GET() { return marsApi(principal => reconcileMarsInventory(principal)); }
