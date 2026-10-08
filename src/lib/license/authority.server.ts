/**
 * License Authority — the single server-side source of truth for license state.
 * Frontend input is never trusted: every identifier is re-resolved from the database.
 */
import type { DatabaseClient as Db } from "../backend-types";
import { jsonValue, rateLimitDatabase } from "../backend-types";
import { createHmac } from "node:crypto";
import {
  correlationId,
  decryptSecret,
  hashIp,
  hashToken,
  safeEqual,
  signPayload,
} from "./crypto.server";

export type LicenseStatus =
  "pending" | "active" | "suspended" | "expired" | "revoked" | "cancelled" | "transfer_pending";

export type ValidationResult =
  | "valid"
  | "license_not_found"
  | "license_not_active"
  | "license_expired"
  | "domain_not_authorized"
  | "installation_not_found"
  | "installation_revoked"
  | "feature_not_licensed"
  | "installation_limit_reached"
  | "invalid_signature"
  | "rate_limited";

export const OFFLINE_GRACE_HOURS = 72;
const VALIDATION_LEEWAY_MS = 5 * 60 * 1000; // replay window for signed requests

/* ---------------- events ---------------- */

const SECRET_KEY = /(secret|token|password|key|authorization|signature)/i;

function scrub(metadata: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    out[key] = SECRET_KEY.test(key) ? "[redacted]" : value;
  }
  return out;
}

export async function recordLicenseEvent(
  db: Db,
  input: {
    licenseId?: string | null;
    clientId?: string | null;
    eventType: string;
    actor?: string | null;
    result?: string;
    resource?: string | null;
    correlation?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  await db.from("license_events").insert({
    license_id: input.licenseId ?? null,
    client_id: input.clientId ?? null,
    event_type: input.eventType,
    actor: input.actor ?? null,
    result: input.result ?? "success",
    resource: input.resource ?? null,
    correlation_id: input.correlation ?? correlationId(),
    metadata: jsonValue(scrub(input.metadata ?? {})),
  });
}

export async function recordLicenseSecurityEvent(
  db: Db,
  input: {
    licenseId?: string | null;
    clientId?: string | null;
    actor?: string | null;
    eventType: string;
    severity?: "info" | "warning" | "critical";
    resource?: string | null;
    result?: string;
    message: string;
    correlation?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  await db.from("license_security_events").insert({
    license_id: input.licenseId ?? null,
    client_id: input.clientId ?? null,
    actor: input.actor ?? null,
    event_type: input.eventType,
    severity: input.severity ?? "warning",
    resource: input.resource ?? null,
    result: input.result ?? "denied",
    message: input.message.slice(0, 1000),
    correlation_id: input.correlation ?? correlationId(),
    metadata: jsonValue(scrub(input.metadata ?? {})),
  });
}

/* ---------------- rate limiting ---------------- */

export async function rateLimit(
  db: Db,
  bucket: string,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; count: number; retryAfterSeconds: number; error?: string }> {
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs).toISOString();
  const keyHash = hashToken(`${bucket}:${key}`);

  // One atomic statement. Reading the row, adding one in JavaScript and writing
  // it back loses increments under concurrent requests, which let the limit be
  // bypassed by issuing requests in parallel.
  const { data: count, error } = await rateLimitDatabase(db).rpc("consume_rate_limit", {
    p_bucket: bucket,
    p_key_hash: keyHash,
    p_window_start: windowStart,
  });
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((new Date(windowStart).getTime() + windowMs - Date.now()) / 1000),
  );
  if (error || typeof count !== "number") {
    // The counter could not be advanced, so this request cannot be proven to be
    // within the limit. Refuse rather than allow an unmetered request through.
    return {
      allowed: false,
      count: limit + 1,
      retryAfterSeconds,
      error: error?.message ?? "Rate limit storage returned an invalid counter.",
    };
  }
  return { allowed: count <= limit, count, retryAfterSeconds };
}

/* ---------------- domain rules ---------------- */

export function normalizeDomain(value: string) {
  let host = value.trim().toLowerCase();
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      /* fall through to manual cleanup */
    }
  }
  host = host
    .replace(/^https?:\/\//, "")
    .split("/")[0]!
    .split(":")[0]!;
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host))
    throw new Error("Enter a valid domain, for example clientdomain.com");
  return host;
}

/* ---------------- signed request verification ---------------- */

/**
 * Deployments authenticate each call with an HMAC over `timestamp.body`
 * keyed by their license secret. The secret itself is never transmitted.
 */
export function buildRequestSignature(rawBody: string, timestamp: string, licenseSecret: string) {
  return createHmac("sha256", licenseSecret).update(`${timestamp}.${rawBody}`).digest("base64url");
}

export function verifyRequestSignature(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  licenseSecret: string,
) {
  if (!signature || !timestamp) return { ok: false as const, reason: "missing_signature" };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > VALIDATION_LEEWAY_MS) {
    return { ok: false as const, reason: "stale_request" };
  }
  const expected = buildRequestSignature(rawBody, timestamp, licenseSecret);
  return safeEqual(expected, signature)
    ? { ok: true as const }
    : { ok: false as const, reason: "invalid_signature" };
}

/* ---------------- validation ---------------- */

export type ValidationInput = {
  licenseKey: string;
  domain: string;
  installationRef?: string | null;
  feature?: string | null;
  version?: string | null;
  ip?: string | null;
  signature?: string | null;
  timestamp?: string | null;
  rawBody?: string;
};

export type ValidationDecision = {
  ok: boolean;
  result: ValidationResult;
  correlation: string;
  license?: {
    licenseKey: string;
    status: LicenseStatus;
    features: string[];
    expiresAt: string | null;
    domain: string;
    installationRef: string | null;
    currentVersion: string | null;
  };
  grace?: { validUntil: string; signature: string };
  retryAfterSeconds?: number;
};

function expired(expiresAt: string | null) {
  return Boolean(expiresAt && new Date(expiresAt).getTime() < Date.now());
}

export async function validateLicense(db: Db, input: ValidationInput): Promise<ValidationDecision> {
  const correlation = correlationId();
  const ipHash = hashIp(input.ip);

  const limit = await rateLimit(
    db,
    "license_validate",
    input.licenseKey || (input.ip ?? "anonymous"),
    120,
    300,
  );
  if (!limit.allowed) {
    await recordLicenseSecurityEvent(db, {
      eventType: "validation_rate_limited",
      message: `Validation rate limit reached for ${input.licenseKey.slice(0, 8)}…`,
      correlation,
      metadata: { attempts: limit.count },
    });
    return {
      ok: false,
      result: "rate_limited",
      correlation,
      retryAfterSeconds: limit.retryAfterSeconds,
    };
  }

  const { data: license } = await db
    .from("licenses")
    .select(
      "id, license_key, client_id, status, features, expires_at, max_installations, secret_hash, current_version",
    )
    .eq("license_key", input.licenseKey.trim().toUpperCase())
    .maybeSingle();

  const fail = async (
    result: ValidationResult,
    message: string,
    licenseId?: string | null,
    clientId?: string | null,
  ) => {
    await db.from("license_validations").insert({
      license_id: licenseId ?? null,
      domain: input.domain ?? null,
      result,
      reason: message,
      correlation_id: correlation,
    });
    await recordLicenseSecurityEvent(db, {
      licenseId: licenseId ?? null,
      clientId: clientId ?? null,
      eventType: `validation_${result}`,
      message,
      correlation,
      metadata: { domain: input.domain, installation: input.installationRef ?? null, ipHash },
    });
    return { ok: false, result, correlation } satisfies ValidationDecision;
  };

  if (!license) return fail("license_not_found", "No license matches the supplied key.");

  // Deployments always sign their calls; the shared secret never leaves the server.
  if (input.signature !== undefined) {
    let secret: string;
    try {
      secret = await decryptSecret(license.secret_hash);
    } catch {
      return fail(
        "invalid_signature",
        "License secret could not be verified.",
        license.id,
        license.client_id,
      );
    }
    const verified = verifyRequestSignature(
      input.rawBody ?? "",
      input.signature,
      input.timestamp ?? null,
      secret,
    );
    if (!verified.ok)
      return fail(
        "invalid_signature",
        `Request signature rejected (${verified.reason}).`,
        license.id,
        license.client_id,
      );
  }

  let domain: string;
  try {
    domain = normalizeDomain(input.domain ?? "");
  } catch {
    return fail(
      "domain_not_authorized",
      "Domain is not a valid hostname.",
      license.id,
      license.client_id,
    );
  }

  if (license.status !== "active") {
    return fail(
      "license_not_active",
      `License state is ${license.status}.`,
      license.id,
      license.client_id,
    );
  }
  if (expired(license.expires_at)) {
    await db.from("licenses").update({ status: "expired" }).eq("id", license.id);
    return fail(
      "license_expired",
      "License expiry date has passed.",
      license.id,
      license.client_id,
    );
  }

  const { data: authorizedDomain } = await db
    .from("license_domains")
    .select("id, domain")
    .eq("license_id", license.id)
    .eq("status", "active")
    .eq("domain", domain)
    .maybeSingle();
  if (!authorizedDomain) {
    return fail(
      "domain_not_authorized",
      `Domain ${domain} is not authorized for this license.`,
      license.id,
      license.client_id,
    );
  }

  let installation: {
    id: string;
    installation_ref: string;
    status: string;
    domain: string;
  } | null = null;
  if (input.installationRef) {
    const { data } = await db
      .from("license_installations")
      .select("id, installation_ref, status, domain")
      .eq("license_id", license.id)
      .eq("installation_ref", input.installationRef)
      .maybeSingle();
    if (!data)
      return fail(
        "installation_not_found",
        "Installation is not registered for this license.",
        license.id,
        license.client_id,
      );
    if (data.status !== "active")
      return fail(
        "installation_revoked",
        `Installation state is ${data.status}.`,
        license.id,
        license.client_id,
      );
    if (data.domain !== domain) {
      return fail(
        "domain_not_authorized",
        "Installation is bound to a different domain.",
        license.id,
        license.client_id,
      );
    }
    installation = data;
  }

  const features: string[] = license.features ?? [];
  if (input.feature && !features.includes(input.feature)) {
    return fail(
      "feature_not_licensed",
      `Feature ${input.feature} is not included in this license.`,
      license.id,
      license.client_id,
    );
  }

  const now = new Date().toISOString();
  await db.from("licenses").update({ last_validated_at: now }).eq("id", license.id);
  if (installation) {
    await db
      .from("license_installations")
      .update({
        last_validated_at: now,
        last_seen_ip_hash: ipHash,
        ...(input.version != null ? { version: input.version } : {}),
      })
      .eq("id", installation.id);
  }
  await db.from("license_validations").insert({
    license_id: license.id,
    installation_id: installation?.id ?? null,
    domain,
    result: "valid",
    correlation_id: correlation,
  });

  const validUntil = new Date(Date.now() + OFFLINE_GRACE_HOURS * 3600 * 1000).toISOString();
  const gracePayload = {
    licenseKey: license.license_key,
    domain,
    installationRef: installation?.installation_ref ?? null,
    features,
    validUntil,
  };

  return {
    ok: true,
    result: "valid",
    correlation,
    license: {
      licenseKey: license.license_key,
      status: license.status as LicenseStatus,
      features,
      expiresAt: license.expires_at,
      domain,
      installationRef: installation?.installation_ref ?? null,
      currentVersion: license.current_version,
    },
    grace: { validUntil, signature: signPayload(gracePayload) },
  };
}
