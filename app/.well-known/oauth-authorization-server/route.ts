import { oauthReply, serverMetadata, oauthOptions } from "@/lib/mcp/http";
export const GET = () => oauthReply(serverMetadata());
export const OPTIONS = oauthOptions;
