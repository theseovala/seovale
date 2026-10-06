import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { INTEGRATIONS, integrationById } from "@/lib/integrations/registry";
import type { TestResult } from "@/lib/integrations/providers.server";

type Ctx = { supabase: any; userId: string };

async function workspace(context: Ctx) {
  const { data, error } = await context.supabase
    .from("workspace_members")
    .select("workspace_id, role")
    .eq("user_id", context.userId)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("No workspace is assigned to this account.");
  return data as { workspace_id: string; role: "owner" | "admin" | "member" };
}

function requireAdmin(member: { role: string }) {
  if (member.role === "member") throw new Error("Only a workspace owner or admin can manage integrations.");
}

/** Non-secret projection — credential columns are never selected. */
const SAFE_COLUMNS =
  "provider,kind,status,account_ref,account_label,scopes,token_expires_at,connected_at,last_tested_at,last_test_ok,last_error";

export const listIntegrations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const member = await workspace(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { providerConfigured } = await import("@/lib/integrations/providers.server");
    const { loadProviderCredentials, credentialHints } = await import("@/lib/integrations/credentials.server");
    const groups = Array.from(new Set(INTEGRATIONS.map((d) => d.credentialGroup ?? d.id)));
    const bags: Record<string, Record<string, string>> = {};
    for (const group of groups) bags[group] = await loadProviderCredentials(supabaseAdmin, member.workspace_id, group);
    const hints = await credentialHints(supabaseAdmin, member.workspace_id);
    const maskedFor = (definition: (typeof INTEGRATIONS)[number]) =>
      (definition.credentialFields ?? []).map((field) => {
        const stored = hints.find((h) => h.provider === (definition.credentialGroup ?? definition.id) && h.field_key === field.key);
        return {
          key: field.key,
          label: field.label,
          secret: field.secret,
          placeholder: field.placeholder ?? null,
          hint: field.hint ?? null,
          masked: stored?.masked_hint ?? null,
          updatedAt: stored?.updated_at ?? null,
          fromEnvironment: !stored && Boolean(process.env[field.key]),
        };
      });
    const { data, error } = await supabaseAdmin
      .from("integration_connections")
      .select(SAFE_COLUMNS)
      .eq("workspace_id", member.workspace_id);
    if (error) throw error;
    const rows = new Map((data ?? []).map((row: any) => [row.provider, row]));

    // Live health + rate-limit state, read from the rows the adapters actually wrote.
    const healthRows = await supabaseAdmin
      .from("integration_health")
      .select("provider,status,latency_ms,outcome_code,last_error,last_checked_at,last_ok_at")
      .eq("workspace_id", member.workspace_id);
    const health = new Map((healthRows.data ?? []).map((row: any) => [row.provider, row]));
    const limitRows = await supabaseAdmin
      .from("integration_rate_limits")
      .select("provider,limit_value,remaining,reset_at,recorded_at")
      .eq("workspace_id", member.workspace_id)
      .order("recorded_at", { ascending: false });
    const limits = new Map<string, any>();
    for (const row of limitRows.data ?? []) if (!limits.has(row.provider)) limits.set(row.provider, row);
    const syncRows = await supabaseAdmin
      .from("provider_resources")
      .select("provider,last_synced_at")
      .eq("workspace_id", member.workspace_id)
      .not("last_synced_at", "is", null)
      .order("last_synced_at", { ascending: false });
    const lastSync = new Map<string, string>();
    for (const row of syncRows.data ?? []) if (!lastSync.has(row.provider)) lastSync.set(row.provider, row.last_synced_at);

    const liveState = (providerId: string) => {
      const h = health.get(providerId) as any;
      const l = limits.get(providerId) as any;
      return {
        lastSyncAt: lastSync.get(providerId) ?? null,
        lastSuccessAt: h?.last_ok_at ?? null,
        lastCheckedAt: h?.last_checked_at ?? null,
        latencyMs: h?.latency_ms ?? null,
        outcomeCode: h?.outcome_code ?? null,
        rateLimit: l ? { limit: l.limit_value, remaining: l.remaining, resetAt: l.reset_at, recordedAt: l.recorded_at } : null,
      };
    };

    const google = await supabaseAdmin
      .from("google_business_connections")
      .select("google_account_email,status,last_synced_at,last_error")
      .eq("workspace_id", member.workspace_id)
      .maybeSingle();

    return {
      role: member.role,
      items: INTEGRATIONS.map((definition) => {
        if (definition.id === "google_business") {
          const row = google.data;
          return {
            provider: definition.id,
            configured: providerConfigured(definition.id, bags[definition.credentialGroup ?? definition.id]),
            credentials: maskedFor(definition),
            status: row?.status === "connected" ? "connected" : row?.last_error ? "error" : "disconnected",
            accountLabel: row?.google_account_email ?? null,
            accountRef: null,
            scopes: definition.scopes,
            tokenExpiresAt: null,
            connectedAt: null,
            lastTestedAt: row?.last_synced_at ?? null,
            lastTestOk: row?.status === "connected" ? true : null,
            lastError: row?.last_error ?? null,
            ...liveState(definition.id),
          };
        }
        const row = rows.get(definition.id) as any;
        const configured = providerConfigured(definition.id, bags[definition.credentialGroup ?? definition.id]);
        const status =
          definition.kind === "manual"
            ? "unavailable"
            : !configured && !row
              ? "disconnected"
              : (row?.status ?? "disconnected");
        return {
          provider: definition.id,
          configured,
          credentials: maskedFor(definition),
          status,
          accountLabel: row?.account_label ?? null,
          accountRef: row?.account_ref ?? null,
          scopes: row?.scopes?.length ? row.scopes : definition.scopes,
          tokenExpiresAt: row?.token_expires_at ?? null,
          connectedAt: row?.connected_at ?? null,
          lastTestedAt: row?.last_tested_at ?? null,
          lastTestOk: row?.last_test_ok ?? null,
          lastError: row?.last_error ?? null,
          ...liveState(definition.id),
        };
      }),
    };
  });

export const listIntegrationEvents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const member = await workspace(context);
    const { data, error } = await context.supabase
      .from("integration_events")
      .select("id,provider,event_type,level,message,http_status,created_at")
      .eq("workspace_id", member.workspace_id)
      .order("created_at", { ascending: false })
      .limit(40);
    if (error) throw error;
    return data ?? [];
  });

export const startIntegrationOAuth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ provider: z.string(), origin: z.string().url() }).parse(input))
  .handler(async ({ data, context }) => {
    const member = await workspace(context);
    requireAdmin(member);
    const definition = integrationById(data.provider);
    if (!definition || definition.kind !== "oauth2") throw new Error("This integration does not use sign-in authorization.");
    const { assertAllowedOrigin, googleCallbackOrigin } = await import("@/lib/google-business.server");
    const { buildAuthorizationUrl, providerConfigured } = await import("@/lib/integrations/providers.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { loadProviderCredentials } = await import("@/lib/integrations/credentials.server");
    const creds = await loadProviderCredentials(supabaseAdmin, member.workspace_id, data.provider);
    if (!providerConfigured(data.provider, creds)) {
      throw new Error(`${definition.label} is missing its application credentials (${definition.requiredSecrets.join(", ")}).`);
    }
    const { encryptValue, hashState, pkce, randomToken } = await import("@/lib/integrations/crypto.server");
    const origin = assertAllowedOrigin(data.origin);
    const callbackOrigin = googleCallbackOrigin(origin);
    const redirectUri = `${callbackOrigin}/api/public/integrations/callback`;
    const state = randomToken();
    const challenge = definition.id in { google_gmail: 1, youtube: 1, twitter: 1, pinterest: 1 } ? pkce() : null;
    const codes = challenge ?? { verifier: null, challenge: null };
    const { error } = await supabaseAdmin.from("integration_oauth_states").insert({
      workspace_id: member.workspace_id,
      user_id: context.userId,
      provider: data.provider,
      state_hash: hashState(state),
      payload_ciphertext: await encryptValue(JSON.stringify({ verifier: codes.verifier, redirectUri })),
      redirect_origin: origin,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    if (error) throw error;
    await supabaseAdmin.from("integration_events").insert({
      workspace_id: member.workspace_id,
      provider: data.provider,
      event_type: "oauth_started",
      level: "info",
      message: `Authorization requested for ${definition.label}.`,
    });
    return { authorizationUrl: buildAuthorizationUrl(data.provider, redirectUri, state, codes.challenge, creds) };
  });

export const saveIntegrationAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ provider: z.string(), accountRef: z.string().trim().min(1).max(200) }).parse(input))
  .handler(async ({ data, context }) => {
    const member = await workspace(context);
    requireAdmin(member);
    const definition = integrationById(data.provider);
    if (!definition || definition.kind !== "api_key") throw new Error("This integration does not use a stored business reference.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("integration_connections").upsert(
      {
        workspace_id: member.workspace_id,
        provider: data.provider,
        kind: "api_key",
        account_ref: data.accountRef,
        status: "disconnected",
        connected_by: context.userId,
      },
      { onConflict: "workspace_id,provider" },
    );
    if (error) throw error;
    return { saved: true };
  });

export const testIntegration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ provider: z.string() }).parse(input))
  .handler(async ({ data, context }) => {
    const member = await workspace(context);
    const definition = integrationById(data.provider);
    if (!definition) throw new Error("Unknown integration.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const providers = await import("@/lib/integrations/providers.server");
    const { loadProviderCredentials } = await import("@/lib/integrations/credentials.server");
    const creds = await loadProviderCredentials(supabaseAdmin, member.workspace_id, data.provider);

    const recordHealth = async (code: string, message: string | null, ok = false) => {
      const now = new Date().toISOString();
      await supabaseAdmin.from("integration_health").upsert(
        {
          workspace_id: member.workspace_id,
          provider: data.provider,
          status: ok ? "healthy" : "unhealthy",
          latency_ms: null,
          outcome_code: code,
          last_error: ok ? null : message,
          last_checked_at: now,
          ...(ok ? { last_ok_at: now } : {}),
        },
        { onConflict: "workspace_id,provider" },
      );
      await supabaseAdmin.from("integration_api_logs").insert({
        workspace_id: member.workspace_id,
        provider: data.provider,
        operation: "connection_test",
        endpoint: "connection_test",
        http_status: null,
        outcome_code: code,
        error_message: ok ? null : message,
      });
    };

    const log = (level: string, message: string, httpStatus: number | null, eventType = "connection_test") =>
      supabaseAdmin.from("integration_events").insert({
        workspace_id: member.workspace_id,
        provider: data.provider,
        event_type: eventType,
        level,
        message: message.slice(0, 500),
        http_status: httpStatus,
      });

    if (definition.kind === "manual") {
      // Partner-only APIs: reported honestly instead of pretending a test is possible.
      const message = definition.manualReason ?? "This provider has no public API for this workspace.";
      const code = definition.approvalRequired ? "APPROVAL_REQUIRED" : "UNAVAILABLE";
      await log("warning", message, null);
      await recordHealth(code, message);
      return { ok: false, status: 0, code: code as "APPROVAL_REQUIRED" | "UNAVAILABLE", message };
    }

    if (definition.id === "google_business") {
      const { data: connection } = await supabaseAdmin
        .from("google_business_connections")
        .select("access_token_ciphertext,refresh_token_ciphertext,token_expires_at,status")
        .eq("workspace_id", member.workspace_id)
        .maybeSingle();
      if (!connection || connection.status !== "connected") {
        const message = "Google Business Profile is not connected yet.";
        await log("warning", message, null);
        await recordHealth("NOT_CONFIGURED", message);
        return { ok: false, status: 0, code: "NOT_CONFIGURED" as const, message };
      }
      const { usableAccessToken } = await import("@/lib/google-business-sync.server");
      try {
        const token = await usableAccessToken(supabaseAdmin, member.workspace_id, connection as any);
        const response = await fetch("https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=1", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const ok = response.ok;
        await log(ok ? "info" : "error", ok ? "Google Business Profile API reachable." : `Google returned HTTP ${response.status}.`, response.status);
        return { ok, status: response.status, message: ok ? "Google Business Profile API reachable." : `Google returned HTTP ${response.status}.` };
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "Google test failed.";
        await log("error", message, null);
        return { ok: false, status: 0, message };
      }
    }

    const { data: row } = await supabaseAdmin
      .from("integration_connections")
      .select("*")
      .eq("workspace_id", member.workspace_id)
      .eq("provider", data.provider)
      .maybeSingle();

    // Circuit breaker: after repeated real failures we stop hammering the
    // provider until the cooldown passes, and say so honestly.
    const ops = await import("@/lib/ops.server");
    const circuit = await ops.checkCircuit(supabaseAdmin, member.workspace_id, data.provider);
    if (!circuit.allowed) {
      const message = `Paused after repeated failures. The next attempt is allowed after ${circuit.cooldownUntil ? new Date(circuit.cooldownUntil).toLocaleString() : "the cooldown"}.`;
      await log("warning", message, null, "circuit_open");
      await recordHealth("RATE_LIMITED", message);
      return { ok: false, status: 0, code: "RATE_LIMITED" as const, message };
    }

    let result: TestResult;

    if (definition.kind === "api_key") {
      result = await providers.testApiKeyProvider(definition.id, row?.account_ref ?? null, creds);
    } else {
      if (!row?.access_token_ciphertext) {
        const message = `${definition.label} is not connected yet.`;
        await log("warning", message, null);
        await recordHealth("NOT_CONFIGURED", message);
        return { ok: false, status: 0, code: "NOT_CONFIGURED" as const, message };
      }
      const { decryptValue, encryptValue } = await import("@/lib/integrations/crypto.server");
      let accessToken = await decryptValue(row.access_token_ciphertext);
      const expiresSoon = row.token_expires_at ? Date.parse(row.token_expires_at) - Date.now() < 120_000 : false;
      if (expiresSoon) {
        if (!row.refresh_token_ciphertext) {
          await supabaseAdmin
            .from("integration_connections")
            .update({ status: "expired", last_error: "Access expired and the provider issued no refresh token. Reconnect the account." })
            .eq("id", row.id);
          await log("warning", "Access token expired without a refresh token.", null, "token_expired");
          await recordHealth("TOKEN_EXPIRED", "Access expired. Reconnect this account.");
          return { ok: false, status: 0, code: "TOKEN_EXPIRED" as const, message: "Access expired. Reconnect this account." };
        }
        try {
          const refreshed = await providers.refreshAccessToken(
            data.provider,
            await decryptValue(row.refresh_token_ciphertext),
            creds,
          );
          accessToken = refreshed.accessToken;
          await supabaseAdmin
            .from("integration_connections")
            .update({
              access_token_ciphertext: await encryptValue(refreshed.accessToken),
              refresh_token_ciphertext: refreshed.refreshToken
                ? await encryptValue(refreshed.refreshToken)
                : row.refresh_token_ciphertext,
              token_expires_at: new Date(Date.now() + refreshed.expiresIn * 1000).toISOString(),
              status: "connected",
              last_error: null,
            })
            .eq("id", row.id);
          await log("info", "Access token refreshed.", null, "token_refreshed");
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : "Token refresh failed.";
          await supabaseAdmin.from("integration_connections").update({ status: "expired", last_error: message }).eq("id", row.id);
          await log("error", message, null, "token_refresh_failed");
          await recordHealth("TOKEN_EXPIRED", message);
          return { ok: false, status: 0, code: "TOKEN_EXPIRED" as const, message };
        }
      }
      const config = providers.OAUTH_PROVIDERS[data.provider];
      if (!config) throw new Error("Unknown integration.");
      result = await config.test(accessToken);
    }

    if (result.ok) {
      await ops.recordCircuitSuccess(supabaseAdmin, member.workspace_id, data.provider);
    } else {
      await ops.recordCircuitFailure(supabaseAdmin, member.workspace_id, data.provider, result.message);
    }

    const status = result.ok ? "connected" : result.status === 401 || result.status === 403 ? "expired" : "error";
    await supabaseAdmin.from("integration_connections").upsert(
      {
        workspace_id: member.workspace_id,
        provider: data.provider,
        kind: definition.kind,
        status,
        last_tested_at: new Date().toISOString(),
        last_test_ok: result.ok,
        last_error: result.ok ? null : result.message,
        ...(result.label ? { account_label: result.label } : {}),
        ...(result.accountRef ? { account_ref: result.accountRef } : {}),
        ...(result.ok ? { connected_at: row?.connected_at ?? new Date().toISOString() } : {}),
      },
      { onConflict: "workspace_id,provider" },
    );
    await log(
      result.ok ? "info" : result.rateLimited ? "warning" : "error",
      result.rateLimited ? `Rate limited by provider: ${result.message}` : result.message,
      result.status || null,
      result.rateLimited ? "rate_limited" : "connection_test",
    );
    // Observability: latest real outcome per provider (workspace-scoped).
    await supabaseAdmin.from("integration_health").upsert(
      {
        workspace_id: member.workspace_id,
        provider: data.provider,
        status: result.ok ? "healthy" : "unhealthy",
        latency_ms: null,
        outcome_code: result.code ?? (result.ok ? "CONNECTED" : "PROVIDER_ERROR"),
        last_error: result.ok ? null : result.message,
        last_checked_at: new Date().toISOString(),
        ...(result.ok ? { last_ok_at: new Date().toISOString() } : {}),
      },
      { onConflict: "workspace_id,provider" },
    );
    await supabaseAdmin.from("integration_api_logs").insert({
      workspace_id: member.workspace_id,
      provider: data.provider,
      operation: "connection_test",
      endpoint: "connection_test",
      http_status: result.status || null,
      outcome_code: result.code ?? (result.ok ? "CONNECTED" : "PROVIDER_ERROR"),
      error_message: result.ok ? null : result.message,
    });
    return { ok: result.ok, status: result.status, message: result.message, code: result.code ?? (result.ok ? "CONNECTED" : "PROVIDER_ERROR") };
  });

export const disconnectIntegration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ provider: z.string() }).parse(input))
  .handler(async ({ data, context }) => {
    const member = await workspace(context);
    requireAdmin(member);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await supabaseAdmin
      .from("integration_connections")
      .select("id, access_token_ciphertext")
      .eq("workspace_id", member.workspace_id)
      .eq("provider", data.provider)
      .maybeSingle();

    // Revoke at the provider first where the provider supports it, so the
    // token is dead even though the local record is about to be deleted.
    let revokeNote = "No stored access token to revoke.";
    if (row?.access_token_ciphertext) {
      const { decryptValue } = await import("@/lib/integrations/crypto.server");
      const { revokeOAuthToken } = await import("@/lib/integrations/providers.server");
      try {
        const outcome = await revokeOAuthToken(data.provider, await decryptValue(row.access_token_ciphertext));
        revokeNote = outcome.message;
      } catch (caught) {
        revokeNote = caught instanceof Error ? caught.message : "Revoke attempt failed.";
      }
    }

    const { error } = await supabaseAdmin
      .from("integration_connections")
      .delete()
      .eq("workspace_id", member.workspace_id)
      .eq("provider", data.provider);
    if (error) throw error;
    await supabaseAdmin
      .from("integration_health")
      .update({ status: "unknown", outcome_code: "NOT_CONFIGURED", last_error: null, last_checked_at: new Date().toISOString() })
      .eq("workspace_id", member.workspace_id)
      .eq("provider", data.provider);
    await supabaseAdmin.from("integration_events").insert({
      workspace_id: member.workspace_id,
      provider: data.provider,
      event_type: "disconnected",
      level: "info",
      message: `Connection removed and stored credentials deleted. ${revokeNote}`.slice(0, 500),
    });
    return { disconnected: true, revokeNote };
  });

/**
 * Provider configuration panel: stores application credentials encrypted,
 * validates them server-side and returns only masked values.
 */
export const saveProviderCredentials = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        provider: z.string(),
        values: z.record(z.string(), z.string().max(4000)),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const member = await workspace(context);
    requireAdmin(member);
    const definition = integrationById(data.provider);
    if (!definition?.credentialFields?.length) throw new Error("This integration has no configurable credentials.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const credentials = await import("@/lib/integrations/credentials.server");
    const providers = await import("@/lib/integrations/providers.server");

    const saved = await credentials.saveProviderCredentials(
      supabaseAdmin,
      member.workspace_id,
      data.provider,
      context.userId,
      data.values,
    );
    if (saved.length === 0) throw new Error("Enter at least one credential value.");

    const bag = await credentials.loadProviderCredentials(supabaseAdmin, member.workspace_id, data.provider);
    const missing = definition.requiredSecrets.filter((key) => !bag[key] && !process.env[key]);

    const log = (level: string, message: string, eventType: string, httpStatus: number | null = null) =>
      supabaseAdmin.from("integration_events").insert({
        workspace_id: member.workspace_id,
        provider: data.provider,
        event_type: eventType,
        level,
        message: message.slice(0, 500),
        http_status: httpStatus,
      });

    await log("info", `Credentials updated (${saved.join(", ")}) by workspace ${member.role}.`, "credentials_saved");

    if (missing.length > 0) {
      return { saved: saved.length, verified: false, message: `Still missing: ${missing.join(", ")}.` };
    }

    // API-key providers can be verified immediately with a real provider call.
    if (definition.kind === "api_key") {
      const { data: row } = await supabaseAdmin
        .from("integration_connections")
        .select("account_ref,connected_at")
        .eq("workspace_id", member.workspace_id)
        .eq("provider", data.provider)
        .maybeSingle();
      const result = await providers.testApiKeyProvider(definition.id, row?.account_ref ?? null, bag);
      await supabaseAdmin.from("integration_connections").upsert(
        {
          workspace_id: member.workspace_id,
          provider: data.provider,
          kind: definition.kind,
          status: result.ok ? "connected" : "error",
          last_tested_at: new Date().toISOString(),
          last_test_ok: result.ok,
          last_error: result.ok ? null : result.message,
          ...(result.label ? { account_label: result.label } : {}),
          ...(result.accountRef ? { account_ref: result.accountRef } : {}),
          ...(result.ok ? { connected_at: row?.connected_at ?? new Date().toISOString() } : {}),
        },
        { onConflict: "workspace_id,provider" },
      );
      await log(result.ok ? "info" : "error", result.message, "connection_test", result.status || null);
      return { saved: saved.length, verified: result.ok, message: result.message };
    }

    return {
      saved: saved.length,
      verified: false,
      message: "Credentials stored. Authorize the account to establish a live connection.",
    };
  });

/** Removes stored application credentials (and any live connection using them). */
export const revokeProviderCredentials = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ provider: z.string() }).parse(input))
  .handler(async ({ data, context }) => {
    const member = await workspace(context);
    requireAdmin(member);
    const definition = integrationById(data.provider);
    if (!definition) throw new Error("Unknown integration.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { deleteProviderCredentials } = await import("@/lib/integrations/credentials.server");
    await deleteProviderCredentials(supabaseAdmin, member.workspace_id, data.provider);
    await supabaseAdmin
      .from("integration_connections")
      .delete()
      .eq("workspace_id", member.workspace_id)
      .eq("provider", data.provider);
    await supabaseAdmin.from("integration_events").insert({
      workspace_id: member.workspace_id,
      provider: data.provider,
      event_type: "credentials_revoked",
      level: "warning",
      message: "Stored application credentials and tokens were deleted.",
    });
    return { revoked: true };
  });

export type ProviderHealth = {
  provider: string;
  label: string;
  status: string | null;
  outcomeCode: string | null;
  lastCheckedAt: string | null;
  lastOkAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  errors24h: number;
  rateLimit: { limit: number | null; remaining: number | null; resetAt: string | null } | null;
};

/** Live per-provider health: latest check, last sync, 24h error count and rate-limit snapshot. */
export const getIntegrationHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const member = await workspace(context);
    const wid = member.workspace_id;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const [health, syncJobs, rateLimits, errorLogs] = await Promise.all([
      context.supabase.from("integration_health").select("provider,status,outcome_code,last_error,last_checked_at,last_ok_at").eq("workspace_id", wid),
      context.supabase
        .from("integration_sync_jobs")
        .select("provider,completed_at,status")
        .eq("workspace_id", wid)
        .eq("status", "completed")
        .order("completed_at", { ascending: false })
        .limit(200),
      context.supabase
        .from("integration_rate_limits")
        .select("provider,limit_value,remaining,reset_at,recorded_at")
        .eq("workspace_id", wid)
        .order("recorded_at", { ascending: false })
        .limit(200),
      context.supabase
        .from("integration_api_logs")
        .select("provider")
        .eq("workspace_id", wid)
        .gte("created_at", since)
        .not("error_message", "is", null)
        .limit(5000),
    ]);
    for (const r of [health, syncJobs, rateLimits, errorLogs]) if (r.error) throw r.error;

    const healthBy = new Map((health.data ?? []).map((r: any) => [r.provider, r]));
    const syncBy = new Map<string, string>();
    for (const row of syncJobs.data ?? []) {
      if (row.completed_at && !syncBy.has(row.provider)) syncBy.set(row.provider, row.completed_at);
    }
    const limitBy = new Map<string, any>();
    for (const row of rateLimits.data ?? []) {
      if (!limitBy.has(row.provider)) limitBy.set(row.provider, row);
    }
    const errorsBy = new Map<string, number>();
    for (const row of errorLogs.data ?? []) {
      errorsBy.set(row.provider, (errorsBy.get(row.provider) ?? 0) + 1);
    }

    // Last sync can also come from the connected-platform rows used by Google sync.
    const { data: platforms } = await context.supabase
      .from("connected_platforms")
      .select("platform,last_synced_at")
      .eq("workspace_id", wid);
    for (const row of platforms ?? []) {
      const existing = syncBy.get(row.platform);
      if (row.last_synced_at && (!existing || row.last_synced_at > existing)) syncBy.set(row.platform, row.last_synced_at);
    }

    const items: ProviderHealth[] = INTEGRATIONS.map((definition) => {
      const h: any = healthBy.get(definition.id);
      const limit = limitBy.get(definition.id);
      return {
        provider: definition.id,
        label: definition.label,
        status: h?.status ?? null,
        outcomeCode: h?.outcome_code ?? null,
        lastCheckedAt: h?.last_checked_at ?? null,
        lastOkAt: h?.last_ok_at ?? null,
        lastSyncAt: syncBy.get(definition.id) ?? null,
        lastError: h?.last_error ?? null,
        errors24h: errorsBy.get(definition.id) ?? 0,
        rateLimit: limit
          ? { limit: limit.limit_value ?? null, remaining: limit.remaining ?? null, resetAt: limit.reset_at ?? null }
          : null,
      };
    });
    return { items, generatedAt: new Date().toISOString() };
  });

/** Full per-provider detail for the expandable health card: recent syncs, rate-limit history, 24h errors. */
export const getIntegrationHealthDetail = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ provider: z.string() }).parse(input))
  .handler(async ({ data, context }) => {
    const member = await workspace(context);
    const wid = member.workspace_id;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const [syncJobs, rateLimits, logs] = await Promise.all([
      context.supabase
        .from("integration_sync_jobs")
        .select("job_type,status,attempts,last_error,started_at,completed_at")
        .eq("workspace_id", wid)
        .eq("provider", data.provider)
        .order("created_at", { ascending: false })
        .limit(5),
      context.supabase
        .from("integration_rate_limits")
        .select("limit_value,remaining,reset_at,source,recorded_at")
        .eq("workspace_id", wid)
        .eq("provider", data.provider)
        .order("recorded_at", { ascending: false })
        .limit(5),
      context.supabase
        .from("integration_api_logs")
        .select("operation,method,endpoint,http_status,outcome_code,error_message,created_at")
        .eq("workspace_id", wid)
        .eq("provider", data.provider)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(15),
    ]);
    for (const r of [syncJobs, rateLimits, logs]) if (r.error) throw r.error;

    return {
      syncJobs: (syncJobs.data ?? []).map((j: any) => ({
        jobType: j.job_type,
        status: j.status,
        attempts: j.attempts,
        lastError: j.last_error ?? null,
        startedAt: j.started_at ?? null,
        completedAt: j.completed_at ?? null,
      })),
      rateLimits: (rateLimits.data ?? []).map((r: any) => ({
        limit: r.limit_value ?? null,
        remaining: r.remaining ?? null,
        resetAt: r.reset_at ?? null,
        source: r.source,
        recordedAt: r.recorded_at,
      })),
      errors: (logs.data ?? [])
        .filter((l: any) => l.error_message)
        .map((l: any) => ({
          operation: l.operation,
          method: l.method,
          endpoint: l.endpoint,
          httpStatus: l.http_status ?? null,
          outcomeCode: l.outcome_code ?? null,
          message: l.error_message,
          at: l.created_at,
        })),
      calls24h: (logs.data ?? []).length,
    };
  });

/**
 * Integration overview: every number comes from real rows (connections, health,
 * API logs, audit log). Nothing here is generated or estimated.
 */
export const getIntegrationOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const member = await workspace(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const soon = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const [connections, errors, audits] = await Promise.all([
      supabaseAdmin
        .from("integration_connections")
        .select("provider,status,token_expires_at")
        .eq("workspace_id", member.workspace_id),
      supabaseAdmin
        .from("integration_api_logs")
        .select("provider,created_at,status_code")
        .eq("workspace_id", member.workspace_id)
        .gte("created_at", since)
        .gte("status_code", 400),
      supabaseAdmin
        .from("audit_logs")
        .select("id,action,target_type,target_id,created_at")
        .eq("workspace_id", member.workspace_id)
        .order("created_at", { ascending: false })
        .limit(10),
    ]);

    const rows = (connections.data ?? []) as Array<{ provider: string; status: string; token_expires_at: string | null }>;
    const manual = INTEGRATIONS.filter((d) => d.kind === "manual");

    return {
      totalProviders: INTEGRATIONS.length,
      connected: rows.filter((r) => r.status === "connected").length,
      authErrors: rows.filter((r) => r.status === "error").length,
      expired: rows.filter((r) => r.status === "expired").length,
      expiringSoon: rows.filter((r) => r.token_expires_at && r.token_expires_at < soon && r.status === "connected").length,
      pendingConfiguration: INTEGRATIONS.length - manual.length - rows.filter((r) => r.status === "connected").length,
      approvalRequired: manual.length,
      errors24h: (errors.data ?? []).length,
      auditLog: ((audits.data ?? []) as Array<{
        id: string;
        action: string;
        target_type: string | null;
        target_id: string | null;
        created_at: string;
      }>).map((row) => ({
        id: row.id,
        action: row.action,
        target: row.target_type ?? null,
        targetId: row.target_id ?? null,
        createdAt: row.created_at,
      })),
      generatedAt: new Date().toISOString(),
    };
  });
