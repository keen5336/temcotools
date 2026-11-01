import { getCurrentPrincipal } from "@/lib/auth";
import { NextResponse } from "next/server";
import { exportInventoryPage, INVENTORY_CSV_HEADER } from "@/lib/application/inventory-actions";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({error:"An active login is required."},{status:401});
  if (!principal.capabilities.includes("inventory.read")) return NextResponse.json({error:"Permission required."},{status:403});
  const filters = Object.fromEntries(new URL(request.url).searchParams);
  async function* csv() {
    yield INVENTORY_CSV_HEADER;
    let afterId: string | undefined;
    do { const page = await exportInventoryPage(principal!, {...filters,afterId,limit:1000}); yield page.csv; afterId = page.nextAfterId || undefined; } while(afterId);
  }
  const iterator = csv(), encoder = new TextEncoder();
  const stream = new ReadableStream({async pull(controller) {try {const next=await iterator.next();if(next.done)controller.close();else controller.enqueue(encoder.encode(next.value));}catch(error){controller.error(error);}},async cancel(){await iterator.return();}});
  return new Response(stream,{headers:{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":"attachment; filename=\"inventory-audit.csv\"","Cache-Control":"no-store"}});
}
