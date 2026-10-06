// License authority RPC layer. Authorization, role checks and step-up MFA all
// run on the server; nothing here trusts an identifier supplied by the browser.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type Ctx = { supabase: any; userId: string };

const admin = async () => (await import("@/integrations/supabase/client.server")).supabaseAdmin;

/* ---------------- read models ---------------- */

export const getLicenseOverview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const ctx = context as Ctx;
    const db = await admin();
    const access = await import("@/lib/license/access.server");
    const roles = await access.listRoles(db, ctx.userId);
    const isStaff = roles.length > 0;
    const clientIds = await access.clientIdsForUser(db, ctx.userId);

    const licenseQuery = db
      .from("licenses")
      .select(
        "id, license_key, client_id, status, features, expires_at, activated_at, created_at, last_validated_at, last_download_at, current_version, max_domains, max_installations",
      )
      .order("created_at", { ascending: false })
      .limit(200);
    if (!isStaff) licenseQuery.in("client_id", clientIds.length ? clientIds : ["00000000-0000-0000-0000-000000000000"]);
    const { data: licenses } = await licenseQuery;

    const licenseIds = (licenses ?? []).map((l: any) => l.id);
    const [{ data: clients }, { data: domains }, { data: installations }, { data: releases }, mfa] = await Promise.all([
      isStaff
        ? db.from("license_clients").select("id, name, contact_email, status, created_at").order("created_at", { ascending: false })
        : db.from("license_clients").select("id, name, contact_email, status, created_at").in("id", clientIds.length ? clientIds : ["00000000-0000-0000-0000-000000000000"]),
      licenseIds.length
        ? db.from("license_domains").select("id, license_id, domain, status, created_at").in("license_id", licenseIds)
        : Promise.resolve({ data: [] }),
      licenseIds.length
        ? db
            .from("license_installations")
            .select("id, installation_ref, license_id, domain, status, version, activated_at, last_validated_at")
            .in("license_id", licenseIds)
        : Promise.resolve({ data: [] }),
      // Releases are only visible to staff or to a user who belongs to a client
      // company with at least one licence; nobody else learns a build exists.
      isStaff || clientIds.length
        ? db
            .from("license_releases")
            .select("id, release_ref, version, build_id, channel, checksum_sha256, status, inspection_passed, inspection_report, created_at, published_at, signature")
            .order("created_at", { ascending: false })
            .limit(50)
        : Promise.resolve({ data: [] }),
      db.from("admin_mfa").select("confirmed_at").eq("user_id", ctx.userId).maybeSingle(),
    ]);

    const [{ data: securityEvents }, { data: events }, { data: downloads }] = await Promise.all([
      roles.some((r) => ["owner", "super_admin", "security_admin"].includes(r))
        ? db.from("license_security_events").select("*").order("created_at", { ascending: false }).limit(100)
        : Promise.resolve({ data: [] }),
      licenseIds.length
        ? db.from("license_events").select("*").in("license_id", licenseIds).order("created_at", { ascending: false }).limit(100)
        : Promise.resolve({ data: [] }),
      licenseIds.length
        ? db
            .from("license_download_events")
            .select("id, license_id, release_id, result, reason, created_at")
            .in("license_id", licenseIds)
            .order("created_at", { ascending: false })
            .limit(100)
        : Promise.resolve({ data: [] }),
    ]);

    return {
      roles,
      isStaff,
      mfaEnabled: Boolean(mfa.data?.confirmed_at),
      clients: clients ?? [],
      licenses: (licenses ?? []).map((license: any) => ({
        ...license,
        domains: (domains ?? []).filter((d: any) => d.license_id === license.id),
        installations: (installations ?? []).filter((i: any) => i.license_id === license.id),
      })),
      releases: (releases ?? []).map((r: any) => ({ ...r, signed: Boolean(r.signature) })),
      securityEvents: securityEvents ?? [],
      events: events ?? [],
      downloads: downloads ?? [],
    };
  });

/* ---------------- MFA ---------------- */

export const getMfaStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const ctx = context as Ctx;
    const db = await admin();
    const { data } = await db.from("admin_mfa").select("confirmed_at, last_used_at, locked_until").eq("user_id", ctx.userId).maybeSingle();
    return { enrolled: Boolean(data), confirmed: Boolean(data?.confirmed_at), lastUsedAt: data?.last_used_at ?? null, lockedUntil: data?.locked_until ?? null };
  });

export const startMfaEnrollment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const ctx = context as Ctx;
    const db = await admin();
    const crypto = await import("@/lib/license/crypto.server");
    const { data: existing } = await db.from("admin_mfa").select("confirmed_at").eq("user_id", ctx.userId).maybeSingle();
    if (existing?.confirmed_at) throw new Error("Two-factor authentication is already active for this account.");

    const secret = crypto.generateTotpSecret();
    const recoveryCodes = crypto.generateRecoveryCodes();
    const { data: profile } = await db.from("profiles").select("email").eq("id", ctx.userId).maybeSingle();
    await db.from("admin_mfa").upsert(
      {
        user_id: ctx.userId,
        secret_ciphertext: await crypto.encryptSecret(secret),
        confirmed_at: null,
        recovery_hashes: recoveryCodes.map((code) => crypto.hashToken(code)),
      },
      { onConflict: "user_id" },
    );
    // The secret and recovery codes are shown exactly once, at enrollment time.
    return { secret, uri: crypto.otpauthUri(profile?.email ?? "admin", secret), recoveryCodes };
  });

export const confirmMfaEnrollment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { code: string }) => z.object({ code: z.string().min(6).max(12) }).parse(input))
  .handler(async ({ data, context }) => {
    const ctx = context as Ctx;
    const db = await admin();
    const crypto = await import("@/lib/license/crypto.server");
    const authority = await import("@/lib/license/authority.server");
    const { data: row } = await db.from("admin_mfa").select("secret_ciphertext, confirmed_at").eq("user_id", ctx.userId).maybeSingle();
    if (!row) throw new Error("Start two-factor setup first.");
    const secret = await crypto.decryptSecret(row.secret_ciphertext);
    if (!crypto.verifyTotp(secret, data.code)) {
      await authority.recordLicenseSecurityEvent(db, {
        actor: ctx.userId,
        eventType: "mfa_enrollment_failed",
        message: "Incorrect authenticator code during two-factor setup.",
      });
      throw new Error("That code is not correct. Try the next code from your authenticator app.");
    }
    await db.from("admin_mfa").update({ confirmed_at: new Date().toISOString(), failed_attempts: 0 }).eq("user_id", ctx.userId);
    await authority.recordLicenseEvent(db, { eventType: "mfa_enabled", actor: ctx.userId, resource: "admin_mfa" });
    return { ok: true };
  });

/** Step-up: a correct TOTP code unlocks one sensitive action for a short period. */
export const verifyStepUp = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { action: string; code: string }) =>
    z.object({ action: z.string().min(3).max(40), code: z.string().min(6).max(12) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const ctx = context as Ctx;
    const db = await admin();
    const crypto = await import("@/lib/license/crypto.server");
    const authority = await import("@/lib/license/authority.server");
    const access = await import("@/lib/license/access.server");

    const limit = await authority.rateLimit(db, "mfa_verify", ctx.userId, 10, 300);
    if (!limit.allowed) {
      await authority.recordLicenseSecurityEvent(db, {
        actor: ctx.userId,
        eventType: "mfa_rate_limited",
        severity: "critical",
        message: "Too many two-factor attempts.",
      });
      throw new Error("Too many attempts. Wait a few minutes and try again.");
    }

    const { data: row } = await db.from("admin_mfa").select("secret_ciphertext, confirmed_at, recovery_hashes").eq("user_id", ctx.userId).maybeSingle();
    if (!row?.confirmed_at) throw new Error("Set up two-factor authentication before using this action.");

    const secret = await crypto.decryptSecret(row.secret_ciphertext);
    let ok = crypto.verifyTotp(secret, data.code);
    if (!ok) {
      // Recovery codes are single-use.
      const hash = crypto.hashToken(data.code.trim().toUpperCase());
      const remaining: string[] = (row.recovery_hashes ?? []).filter((h: string) => h !== hash);
      if (remaining.length !== (row.recovery_hashes ?? []).length) {
        ok = true;
        await db.from("admin_mfa").update({ recovery_hashes: remaining }).eq("user_id", ctx.userId);
      }
    }
    if (!ok) {
      await authority.recordLicenseSecurityEvent(db, {
        actor: ctx.userId,
        eventType: "mfa_failed",
        resource: data.action,
        message: "Incorrect two-factor code.",
      });
      throw new Error("That code is not correct.");
    }
    await db.from("admin_mfa").update({ last_used_at: new Date().toISOString(), failed_attempts: 0 }).eq("user_id", ctx.userId);
    const expiresAt = await access.grantStepUp(db, ctx.userId, data.action);
    await authority.recordLicenseEvent(db, { eventType: "step_up_granted", actor: ctx.userId, resource: data.action });
    return { expiresAt };
  });

/* ---------------- administration ---------------- */

async function guard(db: any, userId: string, action: any) {
  const access = await import("@/lib/license/access.server");
  await access.requireRole(db, userId, action);
  await access.requireStepUp(db, userId, action);
}

export const createLicenseClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { name: string; contactEmail?: string }) =>
    z.object({ name: z.string().min(2).max(120), contactEmail: z.string().email().optional() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const ctx = context as Ctx;
    const db = await admin();
    await guard(db, ctx.userId, "create_client");
    const authority = await import("@/lib/license/authority.server");
    const { data: client, error } = await db
      .from("license_clients")
      .insert({ name: data.name, contact_email: data.contactEmail ?? null, created_by: ctx.userId })
      .select("id, name")
      .single();
    if (error) throw new Error(error.message);
    await authority.recordLicenseEvent(db, { clientId: client.id, eventType: "client_created", actor: ctx.userId, resource: client.name });
    return client;
  });

export const createLicense = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { clientId: string; domain: string; expiresAt?: string | null; maxInstallations?: number; features?: string[] }) =>
      z
        .object({
          clientId: z.string().uuid(),
          domain: z.string().min(3).max(253),
          expiresAt: z.string().datetime().nullable().optional(),
          maxInstallations: z.number().int().min(1).max(20).optional(),
          features: z.array(z.enum(["SCAN", "REPORT", "CSV", "ADVANCED_AI", "INTEGRATIONS", "HISTORICAL_DATA", "API_ACCESS"])).optional(),
        })
        .parse(input),
  )
  .handler(async ({ data, context }) => {
    const ctx = context as Ctx;
    const db = await admin();
    await guard(db, ctx.userId, "create_license");
    const crypto = await import("@/lib/license/crypto.server");
    const authority = await import("@/lib/license/authority.server");

    const domain = authority.normalizeDomain(data.domain);
    const { data: client } = await db.from("license_clients").select("id").eq("id", data.clientId).maybeSingle();
    if (!client) throw new Error("That client does not exist.");

    const licenseKey = crypto.generateLicenseKey();
    const licenseSecret = crypto.randomToken(32);
    const { data: license, error } = await db
      .from("licenses")
      .insert({
        license_key: licenseKey,
        client_id: data.clientId,
        status: "pending",
        features: data.features ?? ["SCAN", "REPORT", "CSV"],
        max_installations: data.maxInstallations ?? 1,
        expires_at: data.expiresAt ?? null,
        secret_hash: await crypto.encryptSecret(licenseSecret),
        created_by: ctx.userId,
      })
      .select("id, license_key")
      .single();
    if (error) throw new Error(error.message);

    const { error: domainError } = await db
      .from("license_domains")
      .insert({ license_id: license.id, domain, status: "active", verified_at: new Date().toISOString(), created_by: ctx.userId });
    if (domainError) {
      await db.from("licenses").delete().eq("id", license.id);
      throw new Error(domainError.message.includes("duplicate") ? `${domain} is already bound to another license.` : domainError.message);
    }

    await authority.recordLicenseEvent(db, {
      licenseId: license.id,
      clientId: data.clientId,
      eventType: "license_created",
      actor: ctx.userId,
      resource: license.license_key,
      metadata: { domain },
    });
    // The deployment secret is displayed once; only its encrypted form is stored.
    return { licenseKey: license.license_key, licenseSecret, domain };
  });

export const setLicenseStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { licenseId: string; status: string; reason?: string }) =>
    z
      .object({
        licenseId: z.string().uuid(),
        status: z.enum(["pending", "active", "suspended", "expired", "revoked", "cancelled"]),
        reason: z.string().max(400).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const ctx = context as Ctx;
    const db = await admin();
    const action = data.status === "revoked" ? "revoke_license" : "change_license_state";
    await guard(db, ctx.userId, action);
    const authority = await import("@/lib/license/authority.server");

    const { data: license } = await db.from("licenses").select("id, client_id, status, license_key").eq("id", data.licenseId).maybeSingle();
    if (!license) throw new Error("License not found.");

    const patch = { status: data.status, ...(data.status === "active" ? { activated_at: new Date().toISOString() } : {}) };
    const { error } = await db.from("licenses").update(patch).eq("id", data.licenseId);

    if (error) throw new Error(error.message);

    if (data.status === "revoked") {
      await db.from("license_revocations").insert({ license_id: license.id, reason: data.reason ?? "Revoked by administrator", revoked_by: ctx.userId });
      await db.from("license_installations").update({ status: "revoked" }).eq("license_id", license.id);
      await db.from("license_download_tokens").update({ revoked_at: new Date().toISOString() }).eq("license_id", license.id).is("used_at", null);
    }
    await authority.recordLicenseEvent(db, {
      licenseId: license.id,
      clientId: license.client_id,
      eventType: `license_${data.status}`,
      actor: ctx.userId,
      resource: license.license_key,
      metadata: { from: license.status, reason: data.reason ?? null },
    });
    return { ok: true };
  });

export const renewLicense = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { licenseId: string; expiresAt: string }) =>
    z.object({ licenseId: z.string().uuid(), expiresAt: z.string().datetime() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const ctx = context as Ctx;
    const db = await admin();
    await guard(db, ctx.userId, "renew_license");
    const authority = await import("@/lib/license/authority.server");
    const { data: license } = await db.from("licenses").select("id, client_id, status, license_key").eq("id", data.licenseId).maybeSingle();
    if (!license) throw new Error("License not found.");
    const status = license.status === "expired" ? "active" : license.status;
    const { error } = await db.from("licenses").update({ expires_at: data.expiresAt, status }).eq("id", data.licenseId);
    if (error) throw new Error(error.message);
    await authority.recordLicenseEvent(db, {
      licenseId: license.id,
      clientId: license.client_id,
      eventType: "license_renewed",
      actor: ctx.userId,
      resource: license.license_key,
      metadata: { expiresAt: data.expiresAt },
    });
    return { ok: true };
  });

export const changeLicenseDomain = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { licenseId: string; domain: string }) =>
    z.object({ licenseId: z.string().uuid(), domain: z.string().min(3).max(253) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const ctx = context as Ctx;
    const db = await admin();
    await guard(db, ctx.userId, "change_domain");
    const authority = await import("@/lib/license/authority.server");
    const domain = authority.normalizeDomain(data.domain);
    const { data: license } = await db.from("licenses").select("id, client_id, license_key").eq("id", data.licenseId).maybeSingle();
    if (!license) throw new Error("License not found.");

    await db.from("license_domains").update({ status: "revoked" }).eq("license_id", license.id).eq("status", "active");
    const { error } = await db
      .from("license_domains")
      .upsert(
        { license_id: license.id, domain, status: "active", verified_at: new Date().toISOString(), created_by: ctx.userId },
        { onConflict: "license_id,domain" },
      );
    if (error) throw new Error(error.message.includes("duplicate") ? `${domain} is already bound to another license.` : error.message);
    // Existing installations are bound to the previous domain and must re-register.
    await db.from("license_installations").update({ status: "reset" }).eq("license_id", license.id).eq("status", "active");
    await authority.recordLicenseEvent(db, {
      licenseId: license.id,
      clientId: license.client_id,
      eventType: "domain_changed",
      actor: ctx.userId,
      resource: license.license_key,
      metadata: { domain },
    });
    return { ok: true, domain };
  });

export const resetInstallation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { installationId: string }) => z.object({ installationId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const ctx = context as Ctx;
    const db = await admin();
    await guard(db, ctx.userId, "reset_installation");
    const authority = await import("@/lib/license/authority.server");
    const { data: installation } = await db
      .from("license_installations")
      .select("id, license_id, client_id, installation_ref")
      .eq("id", data.installationId)
      .maybeSingle();
    if (!installation) throw new Error("Installation not found.");
    const { error } = await db.from("license_installations").update({ status: "reset" }).eq("id", installation.id);
    if (error) throw new Error(error.message);
    await authority.recordLicenseEvent(db, {
      licenseId: installation.license_id,
      clientId: installation.client_id,
      eventType: "installation_reset",
      actor: ctx.userId,
      resource: installation.installation_ref,
    });
    return { ok: true };
  });

export const transferLicense = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { licenseId: string; toClientId: string }) =>
    z.object({ licenseId: z.string().uuid(), toClientId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const ctx = context as Ctx;
    const db = await admin();
    await guard(db, ctx.userId, "transfer_license");
    const authority = await import("@/lib/license/authority.server");
    const { data: license } = await db.from("licenses").select("id, client_id, license_key").eq("id", data.licenseId).maybeSingle();
    if (!license) throw new Error("License not found.");
    const { data: target } = await db.from("license_clients").select("id").eq("id", data.toClientId).maybeSingle();
    if (!target) throw new Error("Target client does not exist.");

    const { data: transfer, error } = await db
      .from("license_transfers")
      .insert({ license_id: license.id, from_client_id: license.client_id, to_client_id: data.toClientId, requested_by: ctx.userId, approved_by: ctx.userId, status: "completed", completed_at: new Date().toISOString() })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    await db.from("licenses").update({ client_id: data.toClientId }).eq("id", license.id);
    await db.from("license_installations").update({ client_id: data.toClientId, status: "reset" }).eq("license_id", license.id);
    await authority.recordLicenseEvent(db, {
      licenseId: license.id,
      clientId: data.toClientId,
      eventType: "license_transferred",
      actor: ctx.userId,
      resource: license.license_key,
      metadata: { transferId: transfer.id },
    });
    return { ok: true };
  });

/* ---------------- secure download ---------------- */

export const requestDownload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { licenseId: string; releaseId: string }) =>
    z.object({ licenseId: z.string().uuid(), releaseId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const ctx = context as Ctx;
    const db = await admin();
    const access = await import("@/lib/license/access.server");
    const authority = await import("@/lib/license/authority.server");
    const operations = await import("@/lib/license/operations.server");

    // Either staff with the download permission, or a user of the owning client.
    const roles = await access.listRoles(db, ctx.userId);
    const staffAllowed = roles.some((r) => (access.SENSITIVE_ACTIONS.download_package as readonly string[]).includes(r));
    const { data: license } = await db
      .from("licenses")
      .select("id, client_id, status, expires_at, license_key")
      .eq("id", data.licenseId)
      .maybeSingle();
    if (!license) throw new Error("License not found.");
    const clientIds = await access.clientIdsForUser(db, ctx.userId);
    if (!staffAllowed && !clientIds.includes(license.client_id)) {
      await authority.recordLicenseSecurityEvent(db, {
        licenseId: license.id,
        actor: ctx.userId,
        eventType: "unauthorized_download_attempt",
        severity: "critical",
        message: "User requested a package for a license they do not own.",
      });
      throw new Error("You do not have access to this license.");
    }
    if (license.status !== "active") throw new Error(`Downloads are only available for active licenses (this one is ${license.status}).`);

    // Downloading a signed package is a sensitive action: step-up is mandatory.
    await access.requireStepUp(db, ctx.userId, "download_package");

    const { data: release } = await db
      .from("license_releases")
      .select("id, release_ref, version, build_id, checksum_sha256, signature, status, inspection_passed")
      .eq("id", data.releaseId)
      .maybeSingle();
    if (!release || release.status !== "published") throw new Error("That release is not published.");
    if (!release.inspection_passed) throw new Error("That release did not pass artifact inspection.");
    if (!operations.verifyRelease(release)) throw new Error("That release failed its signature check.");

    const issued = await operations.issueDownloadToken(db, {
      licenseId: license.id,
      releaseId: release.id,
      userId: ctx.userId,
    });
    await authority.recordLicenseEvent(db, {
      licenseId: license.id,
      clientId: license.client_id,
      eventType: "download_authorized",
      actor: ctx.userId,
      resource: release.release_ref,
    });
    return {
      url: `/api/public/license/download?token=${encodeURIComponent(issued.token)}`,
      expiresAt: issued.expiresAt,
      version: release.version,
      checksum: release.checksum_sha256,
    };
  });

/* ---------------- access control admin ---------------- */

export const listAdminUsers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const ctx = context as Ctx;
    const db = await admin();
    const access = await import("@/lib/license/access.server");
    const roles = await access.listRoles(db, ctx.userId);
    if (!roles.some((r) => (access.SENSITIVE_ACTIONS.manage_access as readonly string[]).includes(r))) {
      const authority = await import("@/lib/license/authority.server");
      await authority.recordLicenseSecurityEvent(db, {
        actor: ctx.userId,
        eventType: "unauthorized_admin_list",
        severity: "warning",
        result: "denied",
        message: "Account without an access-management role tried to list administrators.",
      });
      throw new Error("You do not have permission to perform this action.");
    }
    const { data } = await db.from("admin_roles").select("id, user_id, role, created_at").order("created_at");
    const userIds = [...new Set((data ?? []).map((row: any) => row.user_id))];
    const { data: profiles } = userIds.length
      ? await db.from("profiles").select("id, email, full_name").in("id", userIds)
      : { data: [] as any[] };
    return {
      allowed: true,
      entries: (data ?? []).map((row: any) => ({
        ...row,
        email: (profiles ?? []).find((p: any) => p.id === row.user_id)?.email ?? null,
      })),
    };
  });

export const setAdminRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { email: string; role: string; grant: boolean }) =>
    z
      .object({
        email: z.string().email(),
        role: z.enum(["owner", "super_admin", "security_admin", "tech_lead", "developer", "qa", "support"]),
        grant: z.boolean(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const ctx = context as Ctx;
    const db = await admin();
    await guard(db, ctx.userId, "manage_access");
    const authority = await import("@/lib/license/authority.server");
    const { data: profile } = await db.from("profiles").select("id, email").ilike("email", data.email).maybeSingle();
    if (!profile) throw new Error("No account with that email exists yet.");
    if (data.grant) {
      const { error } = await db.from("admin_roles").upsert({ user_id: profile.id, role: data.role, granted_by: ctx.userId }, { onConflict: "user_id,role" });
      if (error) throw new Error(error.message);
    } else {
      await db.from("admin_roles").delete().eq("user_id", profile.id).eq("role", data.role);
    }
    await authority.recordLicenseSecurityEvent(db, {
      actor: ctx.userId,
      eventType: data.grant ? "admin_role_granted" : "admin_role_revoked",
      severity: "critical",
      result: "allowed",
      resource: data.role,
      message: `${data.grant ? "Granted" : "Revoked"} ${data.role} for ${data.email}.`,
    });
    return { ok: true };
  });

/* ---------------- releases ---------------- */

/**
 * Publishes an artifact that was already uploaded to the private release
 * bucket. The server re-hashes the artifact itself, re-runs artifact
 * inspection from the uploaded manifest and signs the release.
 */
export const publishRelease = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { version: string; buildId: string; artifactPath: string; channel?: "stable" | "beta"; minSupportedVersion?: string | null; notes?: string }) =>
      z
        .object({
          version: z.string().min(1).max(40),
          buildId: z.string().min(1).max(80),
          artifactPath: z.string().min(3).max(300),
          channel: z.enum(["stable", "beta"]).optional(),
          minSupportedVersion: z.string().max(40).nullable().optional(),
          notes: z.string().max(500).optional(),
        })
        .parse(input),
  )
  .handler(async ({ data, context }) => {
    const ctx = context as Ctx;
    const db = await admin();
    await guard(db, ctx.userId, "publish_release");
    const operations = await import("@/lib/license/operations.server");
    const crypto = await import("@/lib/license/crypto.server");
    const authority = await import("@/lib/license/authority.server");

    const { data: file, error: downloadError } = await db.storage.from(operations.RELEASE_BUCKET).download(data.artifactPath);
    if (downloadError || !file) throw new Error("That artifact was not found in the release storage.");
    const bytes = Buffer.from(await file.arrayBuffer());
    const checksum = crypto.sha256Hex(bytes.toString("base64"));

    // Artifact inspection: the packaging step uploads a manifest of every entry.
    const { data: manifestFile } = await db.storage.from(operations.RELEASE_BUCKET).download(`${data.artifactPath}.manifest.json`);
    if (!manifestFile) throw new Error("No manifest was uploaded next to this artifact — inspection cannot run.");
    const manifest = JSON.parse(await manifestFile.text()) as { entries?: string[] };
    const inspection = operations.inspectArtifactEntries(manifest.entries ?? []);

    const releaseRef = crypto.generateReleaseRef();
    const signature = operations.releaseSignature({
      release_ref: releaseRef,
      version: data.version,
      build_id: data.buildId,
      checksum_sha256: checksum,
    });

    const { data: release, error } = await db
      .from("license_releases")
      .insert({
        release_ref: releaseRef,
        version: data.version,
        build_id: data.buildId,
        channel: data.channel ?? "stable",
        checksum_sha256: checksum,
        signature,
        signing_key_id: operations.currentSigningKeyId(),
        artifact_path: data.artifactPath,
        artifact_bytes: bytes.byteLength,
        status: inspection.passed ? "published" : "draft",
        inspection_passed: inspection.passed,
        inspection_report: inspection,
        min_supported_version: data.minSupportedVersion ?? null,
        notes: data.notes ?? null,
        created_by: ctx.userId,
        published_at: inspection.passed ? new Date().toISOString() : null,
      })
      .select("id, release_ref, status")
      .single();
    if (error) throw new Error(error.message);

    await authority.recordLicenseEvent(db, {
      eventType: inspection.passed ? "release_published" : "release_blocked_by_inspection",
      actor: ctx.userId,
      resource: releaseRef,
      result: inspection.passed ? "success" : "blocked",
      metadata: { version: data.version, violations: inspection.violations.slice(0, 20) },
    });
    if (!inspection.passed) {
      await authority.recordLicenseSecurityEvent(db, {
        actor: ctx.userId,
        eventType: "release_inspection_failed",
        severity: "critical",
        resource: releaseRef,
        message: `Artifact inspection blocked ${data.version}: ${inspection.violations.slice(0, 5).join(", ")}`,
      });
    }
    return { release, inspection, checksum };
  });

export const rollbackRelease = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { releaseId: string }) => z.object({ releaseId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const ctx = context as Ctx;
    const db = await admin();
    await guard(db, ctx.userId, "publish_release");
    const authority = await import("@/lib/license/authority.server");
    const { data: release } = await db.from("license_releases").select("id, release_ref").eq("id", data.releaseId).maybeSingle();
    if (!release) throw new Error("Release not found.");
    await db.from("license_releases").update({ status: "rolled_back" }).eq("id", release.id);
    await db.from("license_download_tokens").update({ revoked_at: new Date().toISOString() }).eq("release_id", release.id).is("used_at", null);
    await authority.recordLicenseEvent(db, { eventType: "release_rolled_back", actor: ctx.userId, resource: release.release_ref });
    return { ok: true };
  });

