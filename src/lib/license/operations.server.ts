/**
 * Installation binding, secure downloads and release integrity.
 * All state transitions happen here so the HTTP and RPC layers stay thin.
 */
import type { DatabaseClient as Db } from "../backend-types";
import {
  correlationId,
  generateInstallationRef,
  hashIp,
  hashToken,
  randomToken,
  sha256Hex,
  signPayload,
  SIGNING_KEY_ID,
  verifyPayload,
} from "./crypto.server";
import {
  normalizeDomain,
  rateLimit,
  recordLicenseEvent,
  recordLicenseSecurityEvent,
} from "./authority.server";

export const DOWNLOAD_TOKEN_TTL_SECONDS = 300;
export const RELEASE_BUCKET = "license-releases";

/* ---------------- installation binding ---------------- */

export type ActivationOutcome =
  | { ok: true; installationRef: string; features: string[]; expiresAt: string | null }
  | { ok: false; result: string; message: string; retryAfterSeconds?: number };

/**
 * Registers a deployment against a license. The fingerprint is a hash supplied
 * by the deployment (domain + deployment id) — no personal or device data.
 */
export async function activateInstallation(
  db: Db,
  input: {
    licenseKey: string;
    domain: string;
    fingerprint: string;
    version?: string | null;
    ip?: string | null;
  },
): Promise<ActivationOutcome> {
  const correlation = correlationId();
  const limit = await rateLimit(
    db,
    "license_activate",
    `${input.licenseKey}:${input.ip ?? "unknown"}`,
    10,
    900,
  );
  if (!limit.allowed) {
    await recordLicenseSecurityEvent(db, {
      eventType: "activation_rate_limited",
      message: "Too many activation attempts for this license.",
      correlation,
      metadata: { attempts: limit.count },
    });
    return {
      ok: false,
      result: "rate_limited",
      message: "Too many activation attempts. Try again shortly.",
      retryAfterSeconds: limit.retryAfterSeconds,
    };
  }

  const { data: license } = await db
    .from("licenses")
    .select("id, client_id, status, features, expires_at, max_installations, activated_at")
    .eq("license_key", input.licenseKey.trim().toUpperCase())
    .maybeSingle();

  const deny = async (result: string, message: string, licenseId?: string | null) => {
    await db.from("license_activations").insert({
      license_id: licenseId ?? null,
      domain: input.domain,
      result,
      reason: message,
      correlation_id: correlation,
    });
    await recordLicenseSecurityEvent(db, {
      licenseId: licenseId ?? null,
      eventType: `activation_${result}`,
      message,
      correlation,
      metadata: { domain: input.domain, ipHash: hashIp(input.ip) },
    });
    return { ok: false as const, result, message };
  };

  if (!license) return deny("license_not_found", "No license matches the supplied key.");
  if (license.status !== "active" && license.status !== "pending") {
    return deny("license_not_active", `License state is ${license.status}.`, license.id);
  }
  if (license.expires_at && new Date(license.expires_at).getTime() < Date.now()) {
    return deny("license_expired", "License expiry date has passed.", license.id);
  }

  let domain: string;
  try {
    domain = normalizeDomain(input.domain);
  } catch {
    return deny("domain_invalid", "Domain is not a valid hostname.", license.id);
  }

  const { data: authorized } = await db
    .from("license_domains")
    .select("id")
    .eq("license_id", license.id)
    .eq("status", "active")
    .eq("domain", domain)
    .maybeSingle();
  if (!authorized)
    return deny(
      "domain_not_authorized",
      `Domain ${domain} is not authorized for this license.`,
      license.id,
    );

  const fingerprintHash = sha256Hex(`${license.id}:${domain}:${input.fingerprint}`);

  const { data: existing } = await db
    .from("license_installations")
    .select("id, installation_ref, status")
    .eq("license_id", license.id)
    .eq("fingerprint_hash", fingerprintHash)
    .eq("status", "active")
    .maybeSingle();

  if (existing) {
    await db
      .from("license_installations")
      .update({
        last_validated_at: new Date().toISOString(),
        ...(input.version != null ? { version: input.version } : {}),
      })
      .eq("id", existing.id);
    await db.from("license_activations").insert({
      license_id: license.id,
      installation_id: existing.id,
      domain,
      result: "already_active",
      correlation_id: correlation,
    });
    return {
      ok: true,
      installationRef: existing.installation_ref,
      features: license.features ?? [],
      expiresAt: license.expires_at,
    };
  }

  const { count } = await db
    .from("license_installations")
    .select("id", { count: "exact", head: true })
    .eq("license_id", license.id)
    .eq("status", "active");
  if ((count ?? 0) >= (license.max_installations ?? 1)) {
    return deny(
      "installation_limit_reached",
      "This license has reached its installation limit.",
      license.id,
    );
  }

  const installationRef = generateInstallationRef();
  const { data: created, error } = await db
    .from("license_installations")
    .insert({
      installation_ref: installationRef,
      license_id: license.id,
      client_id: license.client_id,
      domain,
      fingerprint_hash: fingerprintHash,
      version: input.version ?? null,
      last_validated_at: new Date().toISOString(),
      last_seen_ip_hash: hashIp(input.ip),
    })
    .select("id")
    .single();
  if (error) return deny("activation_failed", error.message, license.id);

  await db
    .from("licenses")
    .update({ status: "active", activated_at: license.activated_at ?? new Date().toISOString() })
    .eq("id", license.id);
  await db.from("license_activations").insert({
    license_id: license.id,
    installation_id: created.id,
    domain,
    result: "activated",
    correlation_id: correlation,
  });
  await recordLicenseEvent(db, {
    licenseId: license.id,
    clientId: license.client_id,
    eventType: "installation_activated",
    resource: installationRef,
    correlation,
    metadata: { domain },
  });

  return {
    ok: true,
    installationRef,
    features: license.features ?? [],
    expiresAt: license.expires_at,
  };
}

/* ---------------- secure downloads ---------------- */

export async function issueDownloadToken(
  db: Db,
  input: { licenseId: string; releaseId: string; userId: string; ip?: string | null },
) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + DOWNLOAD_TOKEN_TTL_SECONDS * 1000).toISOString();
  const { data, error } = await db
    .from("license_download_tokens")
    .insert({
      token_hash: hashToken(token),
      license_id: input.licenseId,
      release_id: input.releaseId,
      issued_to: input.userId,
      expires_at: expiresAt,
      ip_hash: hashIp(input.ip),
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  await db.from("license_download_events").insert({
    license_id: input.licenseId,
    release_id: input.releaseId,
    token_id: data.id,
    actor: input.userId,
    result: "token_issued",
  });
  return { token, expiresAt };
}

export type RedeemOutcome =
  | { ok: true; url: string; version: string; checksum: string }
  | { ok: false; status: number; message: string };

export async function redeemDownloadToken(
  db: Db,
  rawToken: string,
  ip?: string | null,
): Promise<RedeemOutcome> {
  const limit = await rateLimit(db, "license_download", ip ?? "unknown", 30, 300);
  if (!limit.allowed) return { ok: false, status: 429, message: "Too many download attempts." };

  const { data: tokenRow } = await db
    .from("license_download_tokens")
    .select("id, license_id, release_id, expires_at, used_at, revoked_at, single_use")
    .eq("token_hash", hashToken(rawToken))
    .maybeSingle();

  const deny = async (
    status: number,
    message: string,
    eventType: string,
    licenseId?: string | null,
    tokenId?: string | null,
  ) => {
    await recordLicenseSecurityEvent(db, {
      licenseId: licenseId ?? null,
      eventType,
      message,
      metadata: { ipHash: hashIp(ip) },
    });
    if (licenseId) {
      await db.from("license_download_events").insert({
        license_id: licenseId,
        token_id: tokenId ?? null,
        result: "denied",
        reason: message,
      });
    }
    return { ok: false as const, status, message };
  };

  if (!tokenRow) return deny(404, "Download link is not valid.", "download_token_invalid");
  if (tokenRow.revoked_at)
    return deny(
      403,
      "Download link has been revoked.",
      "download_token_revoked",
      tokenRow.license_id,
      tokenRow.id,
    );
  if (new Date(tokenRow.expires_at).getTime() < Date.now()) {
    return deny(
      403,
      "Download link has expired.",
      "download_token_expired",
      tokenRow.license_id,
      tokenRow.id,
    );
  }
  if (tokenRow.single_use && tokenRow.used_at) {
    return deny(
      403,
      "Download link has already been used.",
      "download_token_replayed",
      tokenRow.license_id,
      tokenRow.id,
    );
  }

  const { data: license } = await db
    .from("licenses")
    .select("id, status, expires_at")
    .eq("id", tokenRow.license_id)
    .maybeSingle();
  if (!license || license.status !== "active") {
    return deny(
      403,
      "License is not active.",
      "download_license_not_active",
      tokenRow.license_id,
      tokenRow.id,
    );
  }

  const { data: release } = await db
    .from("license_releases")
    .select(
      "id, version, artifact_path, checksum_sha256, status, signature, build_id, release_ref, signing_key_id",
    )
    .eq("id", tokenRow.release_id)
    .maybeSingle();
  if (!release || release.status !== "published") {
    return deny(
      404,
      "Release is not available.",
      "download_release_unavailable",
      tokenRow.license_id,
      tokenRow.id,
    );
  }
  if (!verifyRelease(release)) {
    return deny(
      409,
      "Release signature check failed.",
      "release_signature_invalid",
      tokenRow.license_id,
      tokenRow.id,
    );
  }

  const { data: signed, error } = await db.storage
    .from(RELEASE_BUCKET)
    .createSignedUrl(release.artifact_path, 120, { download: true });
  if (error || !signed)
    return deny(
      500,
      "Could not prepare the download.",
      "download_storage_error",
      tokenRow.license_id,
      tokenRow.id,
    );

  await db
    .from("license_download_tokens")
    .update({ used_at: new Date().toISOString() })
    .eq("id", tokenRow.id);
  await db
    .from("licenses")
    .update({ last_download_at: new Date().toISOString() })
    .eq("id", license.id);
  await db.from("license_download_events").insert({
    license_id: license.id,
    release_id: release.id,
    token_id: tokenRow.id,
    result: "downloaded",
  });

  return {
    ok: true,
    url: signed.signedUrl,
    version: release.version,
    checksum: release.checksum_sha256,
  };
}

/* ---------------- release integrity ---------------- */

export type ReleaseRow = {
  release_ref: string;
  version: string;
  build_id: string;
  checksum_sha256: string;
  signature: string | null;
  signing_key_id?: string | null;
};

export function releaseSignature(release: Omit<ReleaseRow, "signature">) {
  return signPayload({
    release_ref: release.release_ref,
    version: release.version,
    build_id: release.build_id,
    checksum: release.checksum_sha256,
  });
}

export function verifyRelease(release: ReleaseRow) {
  if (!release.signature) return false;
  return verifyPayload(
    {
      release_ref: release.release_ref,
      version: release.version,
      build_id: release.build_id,
      checksum: release.checksum_sha256,
    },
    release.signature,
  );
}

export const currentSigningKeyId = SIGNING_KEY_ID;

/** Forbidden paths that must never be inside a client package. */
const FORBIDDEN_PATTERNS = [
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.npmrc$/i,
  /\.pem$/i,
  /\.key$/i,
  /(^|\/)id_rsa/i,
  /(^|\/)\.github\//i,
  /(^|\/)supabase\/\.temp/i,
  /^supabase(\/|$)/i,
  /service[_-]?role/i,
];

export function inspectArtifactEntries(entries: string[]) {
  const violations = entries.filter((entry) =>
    FORBIDDEN_PATTERNS.some((pattern) => pattern.test(entry)),
  );
  return { passed: violations.length === 0, violations, inspectedEntries: entries.length };
}
