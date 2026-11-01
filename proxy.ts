import { NextRequest, NextResponse } from "next/server";
import { isSameOriginMutation, requiresSameOrigin } from "@/lib/auth/request-origin";
import { unsealData } from "iron-session";
import { sessionOptions, type SessionData } from "@/lib/session";
import { createUiContext, matchesUiContext } from "@/lib/auth/ui-context";
import { requiresUiContext, UI_CONTEXT_HEADER, UI_CONTEXT_QUERY, UI_CONTEXT_ERROR_HEADER } from "@/lib/ui-context/shared";

// Central request-forgery protection also covers legacy cookie-authenticated
// routes. Authentication and current permission checks stay inside the app.
export async function proxy(request: NextRequest) {
  const expectedOrigin = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin;
  if (requiresSameOrigin(request.method, request.nextUrl.pathname) && !isSameOriginMutation(request.headers.get("origin"), expectedOrigin)) {
    return NextResponse.json({ error: "Same-origin request required." }, {
      status: 403, headers: { "Cache-Control": "no-store" },
    });
  }
  if (!requiresUiContext(request.method, request.nextUrl.pathname)) return NextResponse.next();
  let expected: string | null = null;
  try {
    const cookie = request.cookies.get(sessionOptions.cookieName)?.value;
    if (cookie) expected = createUiContext(await unsealData<SessionData>(cookie, { password: sessionOptions.password, ttl: sessionOptions.ttl }));
  } catch { /* Invalid/expired/missing cookies cannot establish a UI context. */ }
  if (!expected) return NextResponse.json({ error: "Sign in again.", code: "ui_sign_in_required" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const header = request.headers.get(UI_CONTEXT_HEADER), query = request.nextUrl.searchParams.get(UI_CONTEXT_QUERY);
  const read = request.method === "GET" || request.method === "HEAD";
  const supplied = header ?? (read ? query : null);
  if (!supplied || (query !== null && (!read || (header !== null && header !== query))) || !matchesUiContext(supplied, expected)) {
    const reason = !supplied ? "required" : "changed";
    return NextResponse.json({ error: "This page belongs to a different or older sign-in. Reload the application before continuing; no action was executed.", code: `ui_context_${reason}` }, {
      status: 409, headers: { "Cache-Control": "no-store", [UI_CONTEXT_ERROR_HEADER]: reason },
    });
  }
  let response: NextResponse;
  if (query !== null) {
    // The reserved GET transport field is not domain input (some query schemas
    // are strict). Preserve its verified value as a request header on rewrite.
    const clean = request.nextUrl.clone(); clean.searchParams.delete(UI_CONTEXT_QUERY);
    const headers = new Headers(request.headers); headers.set(UI_CONTEXT_HEADER, supplied!);
    response = NextResponse.rewrite(clean, { request: { headers } });
  } else response = NextResponse.next();
  response.headers.set("Cache-Control", "no-store"); response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export const config = { matcher: "/api/:path*" };
