import { NextRequest, NextResponse } from "next/server";
import { isSameOriginMutation, requiresSameOrigin } from "@/lib/auth/request-origin";

// Central request-forgery protection also covers legacy cookie-authenticated
// routes. Authentication and current permission checks stay inside the app.
export function proxy(request: NextRequest) {
  if (!requiresSameOrigin(request.method, request.nextUrl.pathname)) return NextResponse.next();
  const expectedOrigin = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin;
  if (!isSameOriginMutation(request.headers.get("origin"), expectedOrigin)) {
    return NextResponse.json({ error: "Same-origin request required." }, {
      status: 403, headers: { "Cache-Control": "no-store" },
    });
  }
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
