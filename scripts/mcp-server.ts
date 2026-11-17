// The old DB-connected stdio server had no authenticated user identity.
// Remote MCP is now served by the normal TemcoTools app at /mcp.
console.error("TemcoTools MCP now uses the app's /mcp URL with administrator OAuth approval. Start the normal web app and connect your client to that URL. See docs/mcp.md. The unauthenticated DB stdio server has been retired.");
process.exitCode = 1;
