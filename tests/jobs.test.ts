import { describe, expect, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import {
  cancelJob,
  claimDueJobs,
  claimPendingJob,
  completeJob,
  failJob,
  type IntegrationJob,
} from "../src/lib/jobs.server";

function fixtureJob(): IntegrationJob {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workspace_id: "22222222-2222-4222-8222-222222222222",
    provider: "meta",
    job_type: "process_webhook_event",
    payload: { webhook_event_id: "event" },
    attempts: 0,
    max_attempts: 5,
    status: "pending",
    priority: 3,
    idempotency_key: null,
    last_error: null,
    lease_expires_at: null,
    next_attempt_at: "2026-01-01T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function fixtureDatabase(job: IntegrationJob, failUpdates = false) {
  const client = createClient("https://fixture.invalid", "fixture-only-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (failUpdates && init?.method === "PATCH") {
          return Response.json(
            { code: "08006", message: "Fixture database unavailable" },
            { status: 503 },
          );
        }
        let matches = true;
        for (const [key, condition] of url.searchParams) {
          if (["select", "order", "limit"].includes(key)) continue;
          if (key === "or") {
            matches &&= !job.lease_expires_at || job.lease_expires_at < new Date().toISOString();
            continue;
          }
          const value = job[key as keyof IntegrationJob];
          if (condition.startsWith("eq.")) matches &&= String(value) === condition.slice(3);
          if (condition.startsWith("gt."))
            matches &&= typeof value === "string" && value > condition.slice(3);
          if (condition.startsWith("lte."))
            matches &&= typeof value === "string" && value <= condition.slice(4);
          if (condition.startsWith("in.("))
            matches &&= condition.slice(4, -1).split(",").includes(String(value));
        }
        if (matches && init?.method === "PATCH") Object.assign(job, JSON.parse(String(init.body)));
        return Response.json(matches ? [{ ...job }] : []);
      },
    },
  });
  return client;
}

describe("durable job ownership", () => {
  test("claims a due job once and records an attempt and lease", async () => {
    const job = fixtureJob();
    const db = fixtureDatabase(job);
    const claimed = await claimDueJobs(db, 25);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.attempts).toBe(1);
    expect(claimed[0]?.status).toBe("processing");
    expect(claimed[0]?.lease_expires_at).toBeTruthy();
    expect(await claimDueJobs(db, 25)).toHaveLength(0);
  });

  test("inline webhook work obtains the same lease as cron work", async () => {
    const job = fixtureJob();
    const db = fixtureDatabase(job);
    const claimed = await claimPendingJob(db, job.id);
    expect(claimed?.status).toBe("processing");
    expect(claimed?.attempts).toBe(1);
    expect(await claimPendingJob(db, job.id)).toBeNull();
  });

  test("surfaces claim update failures", async () => {
    const job = fixtureJob();
    await expect(claimDueJobs(fixtureDatabase(job, true), 25)).rejects.toMatchObject({
      message: "Fixture database unavailable",
    });
  });

  test("an active worker completes its job", async () => {
    const job = fixtureJob();
    const db = fixtureDatabase(job);
    const claimed = await claimPendingJob(db, job.id);
    if (!claimed) throw new Error("Fixture was not claimed");
    await completeJob(db, claimed);
    expect(job.status).toBe("completed");
    expect(job.lease_expires_at).toBeNull();
  });

  test("a stale worker cannot complete a reclaimed job", async () => {
    const job = fixtureJob();
    const db = fixtureDatabase(job);
    const claimed = await claimPendingJob(db, job.id);
    if (!claimed) throw new Error("Fixture was not claimed");
    job.attempts += 1;
    await expect(completeJob(db, claimed)).rejects.toThrow("no longer owns");
    expect(job.status).toBe("processing");
  });

  test("an expired lease cannot finalize work", async () => {
    const job = fixtureJob();
    job.status = "processing";
    job.lease_expires_at = "2026-01-01T00:00:00.000Z";
    await expect(completeJob(fixtureDatabase(job), { ...job })).rejects.toThrow("no longer owns");
  });

  test("retry updates require the worker's current lease", async () => {
    const job = fixtureJob();
    const db = fixtureDatabase(job);
    const claimed = await claimPendingJob(db, job.id);
    if (!claimed) throw new Error("Fixture was not claimed");
    await failJob(db, claimed, "Fixture provider failure");
    expect(job.status).toBe("retrying");
    expect(job.last_error).toBe("Fixture provider failure");
    await expect(failJob(db, claimed, "Stale failure")).rejects.toThrow("no longer owns");
  });

  test("cancellation prevents a worker from overwriting the cancelled state", async () => {
    const job = fixtureJob();
    const db = fixtureDatabase(job);
    const claimed = await claimPendingJob(db, job.id);
    if (!claimed) throw new Error("Fixture was not claimed");
    await cancelJob(db, job.id);
    await expect(completeJob(db, claimed)).rejects.toThrow("no longer owns");
    expect(job.status).toBe("cancelled");
  });
});
