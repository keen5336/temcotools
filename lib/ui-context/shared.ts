export const UI_CONTEXT_HEADER = "X-Temco-UI-Context";
export const UI_CONTEXT_QUERY = "__temco_ui";
export const UI_CONTEXT_ERROR_HEADER = "X-Temco-UI-Context-Error";

// Kept self-contained because the exact same classifier is serialized into the
// early browser bootstrap. Never exempt arbitrary Bearer headers or /auth/*.
export function requiresUiContext(method: string, pathname: string): boolean {
  const verb = method.toUpperCase();
  if (!pathname.startsWith("/api/") || verb === "OPTIONS") return false;
  if (verb === "POST" && (pathname === "/api/auth/login" || pathname === "/api/auth/recovery" || pathname === "/api/internal/api-relay-authorization")) return false;
  if (verb === "GET" || verb === "HEAD") {
    if (pathname === "/api/api-relay/loader") return false;
    if (/^\/api\/payloads\/[^/]+\/loader$/.test(pathname)) return false;
    if (/^\/api\/payloads\/[^/]+\/versions\/[^/]+\/[a-f0-9]{64}$/.test(pathname)) return false;
  }
  return true;
}

export function boundApiHref(href: string, context: string | null) {
  if (!href.startsWith("/api/")) return href;
  const url = new URL(href, "http://temco.invalid");
  url.searchParams.set(UI_CONTEXT_QUERY, context ?? "anonymous");
  return url.pathname + url.search + url.hash;
}

export interface BrowserUiContext {
  readonly context: string | null;
  readonly blocked: boolean;
  readonly message: string;
  block: (message?: string) => void;
}
declare global { interface Window { __temcoUiContextV1?: BrowserUiContext } }
