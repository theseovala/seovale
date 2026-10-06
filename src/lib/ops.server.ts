// Server-only observability helpers: security events, provider circuit breaker
// and stalled-job recovery. Everything here writes real, measured state.
// Secrets are never accepted, stored or logged by these helpers.
import type { SupabaseClient } from "@supabase/supabase-js";

export type SecurityCategory =
  | "authentication"
  | "authorization"
  | "api"
  | "integration"
  | "crawler"
  | "webhook"
  | "rate_limit"
  | "tenant";

export interface SecurityEventInput {
  workspaceId: string | null;
  actor?: string | null;
  category: SecurityCategory;
  eventType: string;
  severity?: "info" | "warning" | "critical";
  message: string;
  requestId?: string | null;
  scanId?: string | null;
  provider?: string | null;
  metadata?: Record<string, unknown>;
}

const SECRET_KEY = /(token|secret|password|api[_-]?key|authorization|client_secret|refresh)/i;

/** Drops any key that could carry a credential before the event is stored. */
function scrub(metadata: Record<string, unknown> | undefined) {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (SECRET_KEY.test(key)) continue;
    safe[key] = typeof value === "string" ? value.slice(0, 500) : value;
  }
  return safe;
}

export async function recordSecurityEvent(admin: SupabaseClient, input: SecurityEventInput) {
  await admin.from("security_events").insert({
    workspace_id: input.workspaceId,
    actor: input.actor ?? null,
    category: input.category,
    event_type: input.eventType,
    severity: input.severity ?? "warning",
    message: input.message.slice(0, 1000),
    request_id: input.requestId ?? null,
    scan_id: input.scanId ?? null,
    provider: input.provider ?? null,
    metadata: scrub(input.metadata),
  });
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

export const CIRCUIT_FAILURE_THRESHOLD = 5;
export const CIRCUIT_COOLDOWN_MINUTES = 10;

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitDecision {
  allowed: boolean;
  state: CircuitState;
  reason: string | null;
  cooldownUntil: string | null;
}

/**
 * Decides whether a provider call may go out right now. An open circuit stays
 * shut until its cooldown passes; after that a single probe is allowed
 * (half open) and the outcome closes or re-opens the circuit.
 */
export async function checkCircuit(
  admin: SupabaseClient,
  workspaceId: string,
  provider: string,
): Promise<CircuitDecision> {
  const { data } = await admin
    .from("provider_circuits")
    .select("state,cooldown_until,last_error,failure_count")
    .eq("workspace_id", workspaceId)
    .eq("provider", provider)
    .maybeSingle();
  if (!data || data.state === "closed") {
    return { allowed: true, state: "closed", reason: null, cooldownUntil: null };
  }
  const cooldownUntil = data.cooldown_until as string | null;
  const cooledDown = !cooldownUntil || new Date(cooldownUntil).getTime() <= Date.now();
  if (data.state === "open" && !cooledDown) {
    return {
      allowed: false,
      state: "open",
      reason: `${provider} failed ${data.failure_count} times in a row. Calls are paused until ${cooldownUntil}. Last error: ${data.last_error ?? "unknown"}`,
      cooldownUntil,
    };
  }
  // Cooldown finished (or already half open): allow exactly one probe.
  await admin
    .from("provider_circuits")
    .update({ state: "half_open" })
    .eq("workspace_id", workspaceId)
    .eq("provider", provider);
  return { allowed: true, state: "half_open", reason: null, cooldownUntil };
}

export async function recordCircuitSuccess(admin: SupabaseClient, workspaceId: string, provider: string) {
  await admin.from("provider_circuits").upsert(
    {
      workspace_id: workspaceId,
      provider,
      state: "closed",
      failure_count: 0,
      last_success_at: new Date().toISOString(),
      opened_at: null,
      cooldown_until: null,
      last_error: null,
    },
    { onConflict: "workspace_id,provider" },
  );
}

export async function recordCircuitFailure(
  admin: SupabaseClient,
  workspaceId: string,
  provider: string,
  message: string,
) {
  const { data } = await admin
    .from("provider_circuits")
    .select("failure_count,state")
    .eq("workspace_id", workspaceId)
    .eq("provider", provider)
    .maybeSingle();
  const failures = (data?.failure_count ?? 0) + 1;
  // A failed probe in half-open state re-opens immediately.
  const open = failures >= CIRCUIT_FAILURE_THRESHOLD || data?.state === "half_open";
  await admin.from("provider_circuits").upsert(
    {
      workspace_id: workspaceId,
      provider,
      state: open ? "open" : "closed",
      failure_count: failures,
      last_failure_at: new Date().toISOString(),
      opened_at: open ? new Date().toISOString() : null,
      cooldown_until: open ? new Date(Date.now() + CIRCUIT_COOLDOWN_MINUTES * 60_000).toISOString() : null,
      last_error: message.slice(0, 500),
    },
    { onConflict: "workspace_id,provider" },
  );
  return { state: open ? "open" : "closed", failures };
}

// ---------------------------------------------------------------------------
// Stalled work detection
// ---------------------------------------------------------------------------

export const SCAN_STALL_MINUTES = 20;
export const JOB_STALL_MINUTES = 15;

/**
 * Finds scans and queue jobs that stopped progressing and moves them to an
 * honest terminal or retryable state, so no screen is left spinning forever.
 */
export async function recoverStalled(admin: SupabaseClient, workspaceId: string) {
  const scanCutoff = new Date(Date.now() - SCAN_STALL_MINUTES * 60_000).toISOString();
  const jobCutoff = new Date(Date.now() - JOB_STALL_MINUTES * 60_000).toISOString();
  const recovered: { scans: number; jobs: number } = { scans: 0, jobs: 0 };

  const { data: stalledScans } = await admin
    .from("scans")
    .select("id,attempts,max_attempts,updated_at")
    .eq("workspace_id", workspaceId)
    .in("status", ["running", "retrying"])
    .lt("updated_at", scanCutoff);
  for (const scan of stalledScans ?? []) {
    const canRetry = (scan.attempts ?? 0) < (scan.max_attempts ?? 3);
    await admin
      .from("scans")
      .update({
        status: canRetry ? "queued" : "failed",
        error_message: `Stalled: no progress for over ${SCAN_STALL_MINUTES} minutes.${canRetry ? " Queued for another attempt." : " No attempts left."}`,
        completed_at: canRetry ? null : new Date().toISOString(),
      })
      .eq("id", scan.id);
    await admin
      .from("scan_stages")
      .update({ status: "failed", detail: "Stalled and stopped safely.", completed_at: new Date().toISOString() })
      .eq("scan_id", scan.id)
      .eq("status", "running");
    recovered.scans += 1;
  }

  const { data: stalledJobs } = await admin
    .from("integration_sync_jobs")
    .select("id,attempts,max_attempts")
    .eq("workspace_id", workspaceId)
    .eq("status", "processing")
    .lt("lease_expires_at", jobCutoff);
  for (const job of stalledJobs ?? []) {
    const canRetry = (job.attempts ?? 0) < (job.max_attempts ?? 5);
    await admin
      .from("integration_sync_jobs")
      .update({
        status: canRetry ? "retrying" : "failed",
        next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
        lease_expires_at: null,
        last_error: `Stalled: the worker lease expired over ${JOB_STALL_MINUTES} minutes ago.`,
        completed_at: canRetry ? null : new Date().toISOString(),
      })
      .eq("id", job.id);
    recovered.jobs += 1;
  }
  return recovered;
}
