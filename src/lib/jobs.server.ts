// Durable integration job queue backed by integration_sync_jobs.
// States: pending → processing → completed | failed | retrying | cancelled.
// Exponential backoff on retry, dead-letter on exhaustion, idempotency keys
// prevent duplicate work. No simulated jobs are ever enqueued.
import type { SupabaseClient } from "@supabase/supabase-js";

export type JobStatus = "pending" | "processing" | "completed" | "failed" | "retrying" | "cancelled";

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

/** Claims due jobs by leasing them (single-flight friendly; cron callers are one at a time). */
export async function claimDueJobs(admin: SupabaseClient, limit: number, leaseMinutes = 5) {
  const { data: due, error } = await admin
    .from("integration_sync_jobs")
    .select("id,workspace_id,provider,job_type,payload,attempts,max_attempts,started_at")
    .in("status", ["pending", "retrying"])
    .lte("next_attempt_at", new Date().toISOString())
    .or(`lease_expires_at.is.null,lease_expires_at.lt.${new Date().toISOString()}`)
    .order("priority", { ascending: true })
    .order("next_attempt_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  const rows = due ?? [];
  const claimed: typeof rows = [];
  for (const job of rows) {
    const { data } = await admin
      .from("integration_sync_jobs")
      .update({
        status: "processing" as JobStatus,
        lease_expires_at: new Date(Date.now() + leaseMinutes * 60_000).toISOString(),
        started_at: job.started_at ?? new Date().toISOString(),
        attempts: job.attempts + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .in("status", ["pending", "retrying"])
      .select()
      .single();
    if (data) claimed.push(data as any);
  }
  return claimed;
}

export async function completeJob(admin: SupabaseClient, jobId: string) {
  await admin
    .from("integration_sync_jobs")
    .update({
      status: "completed" as JobStatus,
      lease_expires_at: null,
      last_error: null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId);
}

/** Retry with exponential backoff; dead-letters after max_attempts (no infinite loops). */
export async function failJob(admin: SupabaseClient, job: { id: string; attempts: number; max_attempts: number }, errorMessage: string) {
  const exhausted = job.attempts >= job.max_attempts;
  const backoffSeconds = Math.min(2 ** job.attempts * 60, 3600);
  await admin
    .from("integration_sync_jobs")
    .update({
      status: (exhausted ? "failed" : "retrying") as JobStatus,
      lease_expires_at: null,
      last_error: errorMessage.slice(0, 500),
      next_attempt_at: new Date(Date.now() + backoffSeconds * 1000).toISOString(),
      updated_at: new Date().toISOString(),
      ...(exhausted ? { completed_at: new Date().toISOString() } : {}),
    })
    .eq("id", job.id);
}

export async function cancelJob(admin: SupabaseClient, jobId: string) {
  await admin.from("integration_sync_jobs").update({ status: "cancelled" as JobStatus, updated_at: new Date().toISOString() }).eq("id", jobId);
}
