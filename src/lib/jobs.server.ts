// Durable integration job queue backed by integration_sync_jobs.
// States: pending → processing → completed | failed | retrying | cancelled.
// Exponential backoff on retry, dead-letter on exhaustion, idempotency keys
// prevent duplicate work. No simulated jobs are ever enqueued.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export type JobStatus =
  "pending" | "processing" | "completed" | "failed" | "retrying" | "cancelled";
export type IntegrationJob = Database["public"]["Tables"]["integration_sync_jobs"]["Row"];
type JobLease = Pick<IntegrationJob, "id" | "attempts" | "lease_expires_at">;

export interface EnqueueJobInput {
  workspaceId: string;
  provider: string;
  jobType: string;
  payload?: Record<string, unknown>;
  idempotencyKey?: string | null;
  priority?: number;
  maxAttempts?: number;
}

export async function enqueueJob(
  admin: SupabaseClient,
  input: EnqueueJobInput,
): Promise<{ enqueued: boolean; id: string | null }> {
  const { data, error } = await admin
    .from("integration_sync_jobs")
    .insert({
      workspace_id: input.workspaceId,
      provider: input.provider,
      job_type: input.jobType,
      payload: input.payload ?? {},
      idempotency_key: input.idempotencyKey ?? null,
      priority: input.priority ?? 5,
      max_attempts: input.maxAttempts ?? 5,
      status: "pending" as JobStatus,
    })
    .select("id")
    .single();
  if (error) {
    // Idempotency conflict = the job already exists; that is not an error.
    if (error.code === "23505") return { enqueued: false, id: null };
    throw error;
  }
  return { enqueued: true, id: data?.id ?? null };
}

/** Claims due or abandoned jobs using attempt-checked leases. */
export async function claimDueJobs(admin: SupabaseClient, limit: number, leaseMinutes = 5) {
  const now = new Date().toISOString();
  const { data: due, error } = await admin
    .from("integration_sync_jobs")
    .select("*")
    .in("status", ["pending", "retrying", "processing"])
    .lte("next_attempt_at", now)
    .or(`lease_expires_at.is.null,lease_expires_at.lt.${now}`)
    .order("priority", { ascending: true })
    .order("next_attempt_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  const rows = due ?? [];
  const claimed: IntegrationJob[] = [];
  for (const job of rows) {
    const leased = await claimJob(admin, job, leaseMinutes);
    if (leased) claimed.push(leased);
  }
  return claimed;
}

async function claimJob(admin: SupabaseClient, job: IntegrationJob, leaseMinutes: number) {
  const now = new Date().toISOString();
  const exhausted = job.attempts >= job.max_attempts;
  const update: Database["public"]["Tables"]["integration_sync_jobs"]["Update"] = exhausted
    ? {
        status: "failed",
        lease_expires_at: null,
        completed_at: now,
        updated_at: now,
        last_error:
          job.status === "processing"
            ? "Job lease expired after the maximum number of attempts."
            : "Job stopped after the maximum number of attempts.",
      }
    : {
        status: "processing",
        lease_expires_at: new Date(Date.now() + leaseMinutes * 60_000).toISOString(),
        started_at: job.started_at ?? now,
        attempts: job.attempts + 1,
        updated_at: now,
      };
  const { data, error } = await admin
    .from("integration_sync_jobs")
    .update(update)
    .eq("id", job.id)
    .eq("attempts", job.attempts)
    .eq("status", job.status)
    .in("status", ["pending", "retrying", "processing"])
    .lte("next_attempt_at", now)
    .or(`lease_expires_at.is.null,lease_expires_at.lt.${now}`)
    .select()
    .maybeSingle();
  if (error) throw error;
  return exhausted ? null : (data as IntegrationJob | null);
}

export async function claimPendingJob(admin: SupabaseClient, jobId: string) {
  const { data, error } = await admin
    .from("integration_sync_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw error;
  return data ? claimJob(admin, data, 5) : null;
}

export async function completeJob(admin: SupabaseClient, job: JobLease) {
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("integration_sync_jobs")
    .update({
      status: "completed" as JobStatus,
      lease_expires_at: null,
      last_error: null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", job.id)
    .eq("status", "processing")
    .eq("attempts", job.attempts)
    .eq("lease_expires_at", job.lease_expires_at)
    .gt("lease_expires_at", now)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Job completion refused: worker no longer owns an active lease.");
}

/** Retry with exponential backoff; dead-letters after max_attempts (no infinite loops). */
export async function failJob(
  admin: SupabaseClient,
  job: JobLease & Pick<IntegrationJob, "max_attempts">,
  errorMessage: string,
) {
  const exhausted = job.attempts >= job.max_attempts;
  const backoffSeconds = Math.min(2 ** job.attempts * 60, 3600);
  const { data, error } = await admin
    .from("integration_sync_jobs")
    .update({
      status: (exhausted ? "failed" : "retrying") as JobStatus,
      lease_expires_at: null,
      last_error: errorMessage.slice(0, 500),
      next_attempt_at: new Date(Date.now() + backoffSeconds * 1000).toISOString(),
      updated_at: new Date().toISOString(),
      ...(exhausted ? { completed_at: new Date().toISOString() } : {}),
    })
    .eq("id", job.id)
    .eq("status", "processing")
    .eq("attempts", job.attempts)
    .eq("lease_expires_at", job.lease_expires_at)
    .gt("lease_expires_at", new Date().toISOString())
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Job failure update refused: worker no longer owns an active lease.");
}

export async function cancelJob(admin: SupabaseClient, jobId: string) {
  const { data, error } = await admin
    .from("integration_sync_jobs")
    .update({
      status: "cancelled" as JobStatus,
      lease_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .in("status", ["pending", "retrying", "processing"])
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("The job is no longer cancellable.");
}
