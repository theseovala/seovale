/**
 * Role checks and step-up (MFA) authorization for license administration.
 * Every check runs server-side against the database — never against client input.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordLicenseSecurityEvent } from "./authority.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

export type AdminRole = "owner" | "super_admin" | "security_admin" | "tech_lead" | "developer" | "qa" | "support";

export const ROLE_LABEL: Record<AdminRole, string> = {
  owner: "Owner",
  super_admin: "Super admin",
  security_admin: "Security admin",
  tech_lead: "Tech lead",
  developer: "Developer",
  qa: "QA",
  support: "Support",
};

/** Sensitive operations and the roles allowed to perform them (least privilege). */
export const SENSITIVE_ACTIONS = {
  create_client: ["owner", "super_admin"],
  create_license: ["owner", "super_admin"],
  change_license_state: ["owner", "super_admin"],
  revoke_license: ["owner", "super_admin", "security_admin"],
  renew_license: ["owner", "super_admin"],
  change_domain: ["owner", "super_admin"],
  reset_installation: ["owner", "super_admin", "security_admin"],
  transfer_license: ["owner", "super_admin"],
  publish_release: ["owner", "super_admin", "tech_lead"],
  download_package: ["owner", "super_admin", "tech_lead", "support"],
  manage_access: ["owner", "super_admin", "security_admin"],
} as const;

export type SensitiveAction = keyof typeof SENSITIVE_ACTIONS;

const STEP_UP_TTL_MINUTES = 10;

export async function listRoles(db: Db, userId: string): Promise<AdminRole[]> {
  const { data } = await db.from("admin_roles").select("role").eq("user_id", userId);
  return (data ?? []).map((row: { role: AdminRole }) => row.role);
}

export async function requireRole(db: Db, userId: string, action: SensitiveAction) {
  const roles = await listRoles(db, userId);
  const allowed = SENSITIVE_ACTIONS[action] as readonly string[];
  if (!roles.some((role) => allowed.includes(role))) {
    await recordLicenseSecurityEvent(db, {
      actor: userId,
      eventType: "unauthorized_admin_action",
      severity: "critical",
      resource: action,
      message: `User attempted ${action} without a permitted role.`,
      metadata: { roles },
    });
    throw new Error("You do not have permission to perform this action.");
  }
  return roles;
}

/** Consumes a step-up grant produced by a successful TOTP check. */
export async function requireStepUp(db: Db, userId: string, action: SensitiveAction) {
  const { data } = await db
    .from("admin_step_up")
    .select("id, expires_at")
    .eq("user_id", userId)
    .eq("action", action)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("granted_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) {
    await recordLicenseSecurityEvent(db, {
      actor: userId,
      eventType: "step_up_required",
      severity: "warning",
      resource: action,
      result: "denied",
      message: `Step-up authentication required for ${action}.`,
    });
    throw new Error(`STEP_UP_REQUIRED:${action}`);
  }
  await db.from("admin_step_up").update({ used_at: new Date().toISOString() }).eq("id", data.id);
}

export async function grantStepUp(db: Db, userId: string, action: string) {
  const expiresAt = new Date(Date.now() + STEP_UP_TTL_MINUTES * 60_000).toISOString();
  await db.from("admin_step_up").insert({ user_id: userId, action, expires_at: expiresAt });
  return expiresAt;
}

export async function clientIdsForUser(db: Db, userId: string): Promise<string[]> {
  const { data } = await db.from("license_client_users").select("client_id").eq("user_id", userId);
  return (data ?? []).map((row: { client_id: string }) => row.client_id);
}
