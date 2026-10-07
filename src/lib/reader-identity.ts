import { createHmac } from "node:crypto";

/**
 * Pseudonymous reader identity for flag votes: HMAC of the IP keyed by the
 * server secret. Returns null without a secret so votes are still recorded.
 */
export function hashReaderIp(ip: string, secret: string | undefined = process.env.AUTH_SECRET): string | null {
  if (!secret) return null;
  return createHmac("sha256", secret).update(ip).digest("hex");
}
