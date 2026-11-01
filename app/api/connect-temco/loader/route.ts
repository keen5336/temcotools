import { loadSitePayload } from "@/lib/relay-sites/loader";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = loadSitePayload;
