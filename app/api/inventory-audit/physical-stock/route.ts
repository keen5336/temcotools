import { getCurrentPrincipal } from "@/lib/auth";
import { getPhysicalStock } from "@/lib/warehouse/physical-stock";
import { warehouseReply, warehouseFailure } from "@/lib/warehouse/http";
import { ZodError } from "zod";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const principal=await getCurrentPrincipal(); if(!principal) return warehouseReply({ok:false,error:"Sign in to view physical observations."},401);
    return warehouseReply({ok:true,result:await getPhysicalStock(principal,Object.fromEntries(new URL(request.url).searchParams))});
  } catch(error) { if(error instanceof ZodError) return warehouseReply({ok:false,error:"Check the physical-view filters and page limits."},400); return warehouseFailure(error); }
}
