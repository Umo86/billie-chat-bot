import type { AuthFailureCode } from "./provider";

/** Neon Auth's error shapes, mapped to Billie's few cases (kept apart from the SDK so it's testable). */
export type UpstreamError = { message?: string; status?: number; code?: string } | null | undefined;

/** Turns Neon Auth's error into one of ours. The message is never shown as-is. */
export function classify(error: UpstreamError): { code: AuthFailureCode; message: string } {
  const code = String(error?.code ?? "").toLowerCase();
  const message = String(error?.message ?? "");
  const status = Number(error?.status ?? 0);
  if (code === "not_invited" || /invite-only/i.test(message))
    return { code: "not_allowed", message: "Billie is invite-only. Ask an admin to invite you." };
  if (code.startsWith("network_") || status === 502 || status === 503 || status === 504)
    return {
      code: "unavailable",
      message: "Sign-in is unavailable just now. Try again in a minute.",
    };
  if (code === "invalid_credentials" || code === "user_not_found" || code === "identity_not_found")
    return { code: "invalid_credentials", message: "That email and password don't match." };
  if (code === "user_already_exists" || code === "email_exists" || /already exists/i.test(message))
    return { code: "user_exists", message: "There is already a sign-in for this email." };
  if (code === "weak_password")
    return { code: "weak_password", message: "Choose a longer password (at least 10 characters)." };
  if (code === "bad_jwt" || /token/i.test(message))
    return { code: "invalid_token", message: "This link has expired. Ask for a new one." };
  if (status === 403 || code === "feature_not_supported")
    return { code: "not_allowed", message: "Billie is invite-only. Ask an admin to invite you." };
  if (code === "over_request_rate_limit" || status === 429)
    return {
      code: "unavailable",
      message: "Too many attempts. Wait a few minutes, then try again.",
    };
  return { code: "unknown", message: "Sign-in didn't work. Try again." };
}
