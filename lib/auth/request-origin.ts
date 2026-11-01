const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// The actual bearer MCP resource is /mcp on its separate SDK server. No Next
// /api route (including a made-up /api/mcp) gains an Origin exemption.
export function requiresSameOrigin(method: string, pathname: string): boolean {
  return pathname.startsWith("/api/") && !SAFE_METHODS.has(method.toUpperCase());
}

export function isSameOriginMutation(origin: string | null, expectedOrigin: string): boolean {
  if (!origin || origin === "null") return false;
  try {
    const expected = new URL(expectedOrigin);
    return (expected.protocol === "https:" || expected.protocol === "http:")
      && origin === expected.origin;
  } catch {
    return false;
  }
}
