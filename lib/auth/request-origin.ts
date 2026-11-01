const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Only the dedicated MCP endpoint can use bearer authentication without a
// browser Origin. Its adapter must validate the bearer and must not fall back
// to cookie authentication. A Bearer header never exempts ordinary UI APIs.
export function requiresSameOrigin(method: string, pathname: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase()) && pathname !== "/api/mcp";
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
