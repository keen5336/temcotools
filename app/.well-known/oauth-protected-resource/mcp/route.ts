import { oauthReply, resourceMetadata, oauthOptions } from "@/lib/mcp/http";
export const GET = () => oauthReply(resourceMetadata());
export const OPTIONS = oauthOptions;
