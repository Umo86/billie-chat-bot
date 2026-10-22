import { createHmac } from "node:crypto";
import { derivedSecret } from "@/lib/auth/config";

/**
 * A value only the server knows, which proxy.ts adds to chat-frame requests
 * after setting their Content-Security-Policy. The frame page refuses any
 * request without it, so no path can reach a bot's chat frame unprotected.
 */
export function frameMark(): string {
  const secret = derivedSecret("chat-frame") ?? "unset";
  return createHmac("sha256", secret).update("frame-checked").digest("hex").slice(0, 32);
}
