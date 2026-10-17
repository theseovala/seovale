import { createHmac } from "node:crypto";
import { safeEqual } from "./crypto.server";

export const SESSION_TTL_MS = 15 * 60 * 1000;

type Binding = { licenseKey: string; domain: string; installationRef: string | null; subject?: string };

export function sessionExpiry(now: number, licenseExpiresAt: string | null) {
  const limit = licenseExpiresAt === null ? Infinity : Date.parse(licenseExpiresAt);
  if (Number.isNaN(limit) || limit <= now) throw new Error("License has expired.");
  return Math.min(now + SESSION_TTL_MS, limit);
}

export function signSessionPayload(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function verifySessionToken(token: string, secret: string, binding: Binding, now: number) {
  const parts = token.split(".");
  const [payload, signature] = parts;
  if (parts.length !== 2 || !payload || !signature || !safeEqual(signSessionPayload(payload, secret), signature)) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
    const c = claims as Record<string, unknown>;
    if (c.lic !== binding.licenseKey || c.dom !== binding.domain || c.ins !== binding.installationRef) return null;
    if (binding.subject !== undefined && c.sub !== binding.subject) return null;
    if (typeof c.exp !== "number" || !Number.isFinite(c.exp) || c.exp <= now) return null;
    if (typeof c.iat !== "number" || !Number.isFinite(c.iat) || c.iat > now || c.exp <= c.iat || c.exp - c.iat > SESSION_TTL_MS) return null;
    return { expiresAt: new Date(c.exp).toISOString(), subject: typeof c.sub === "string" ? c.sub : null };
  } catch {
    return null;
  }
}