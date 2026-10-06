// Automatic review scanning: checks stored reviews against platform content
// policies with real AI and records removal cases. No sample data is created.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type Ctx = { supabase: any; userId: string };

async function workspaceIdFor(context: Ctx) {
  const { data, error } = await context.supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", context.userId)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("No workspace is assigned to this account.");
  return data.workspace_id as string;
}

async function memberFor(context: Ctx) {
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

/** Scans reviews that have not been assessed yet and records removal cases. */
export const scanReviewsForRemoval = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ limit: z.number().min(1).max(120).optional() }).parse(input ?? {}))
  .handler(async ({ data, context }) => {
    const workspaceId = await workspaceIdFor(context);
    const { runRemovalScan } = await import("@/lib/removal-scan.server");

    let limit = data.limit;
    if (!limit) {
      const { data: settings } = await context.supabase
        .from("removal_scan_settings")
        .select("batch_size")
        .eq("workspace_id", workspaceId)
        .maybeSingle();
      limit = settings?.batch_size ?? 40;
    }

    const outcome = await runRemovalScan(context.supabase, workspaceId, limit!, context.userId);
    await context.supabase
      .from("removal_scan_settings")
      .update({ last_run_at: new Date().toISOString() })
      .eq("workspace_id", workspaceId);
    return outcome;
  });

/** Reads the automatic scan schedule for the signed-in workspace. */
export const getScanSchedule = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const member = await memberFor(context);
    const { data, error } = await context.supabase
      .from("removal_scan_settings")
      .select("enabled, interval_minutes, batch_size, last_run_at, next_run_at, paused_reason")
      .eq("workspace_id", member.workspace_id)
      .maybeSingle();
    if (error) throw error;
    return {
      canEdit: member.role !== "member",
      enabled: data?.enabled ?? true,
      intervalMinutes: data?.interval_minutes ?? 360,
      batchSize: data?.batch_size ?? 40,
      lastRunAt: data?.last_run_at ?? null,
      nextRunAt: data?.next_run_at ?? null,
      pausedReason: data?.paused_reason ?? null,
    };
  });

/** Updates how often the automatic scan runs and how many reviews it checks. */
export const updateScanSchedule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        enabled: z.boolean().optional(),
        intervalMinutes: z.number().int().min(15).max(10080).optional(),
        batchSize: z.number().int().min(5).max(120).optional(),
        resume: z.boolean().optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const member = await memberFor(context);
    if (member.role === "member") throw new Error("Only a workspace owner or admin can change the scan schedule.");

    const patch: Record<string, unknown> = {};
    if (data.enabled !== undefined) patch["enabled"] = data.enabled;
    if (data.intervalMinutes !== undefined) {
      patch["interval_minutes"] = data.intervalMinutes;
      patch["next_run_at"] = new Date(Date.now() + data.intervalMinutes * 60_000).toISOString();
    }
    if (data.batchSize !== undefined) patch["batch_size"] = data.batchSize;
    if (data.resume) patch["paused_reason"] = null;


    const { data: updated, error } = await context.supabase
      .from("removal_scan_settings")
      .upsert({ workspace_id: member.workspace_id, ...patch }, { onConflict: "workspace_id" })
      .select("enabled, interval_minutes, batch_size, next_run_at, paused_reason")
      .single();
    if (error) throw error;
    return {
      enabled: updated.enabled as boolean,
      intervalMinutes: updated.interval_minutes as number,
      batchSize: updated.batch_size as number,
      nextRunAt: updated.next_run_at as string | null,
      pausedReason: updated.paused_reason as string | null,
    };
  });


/** Moves a removal case through its lifecycle. */
export const updateRemovalCase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        status: z.enum(["flagged", "submitted", "approved", "rejected", "dismissed"]),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const workspaceId = await workspaceIdFor(context);
    const now = new Date().toISOString();

    const { row, evidence, ledger } = await caseLedger(context, workspaceId, data.id);
    const { CASE_STATUSES, assertTransition, appendEntry } = await import("@/lib/removal/lifecycle");

    // Only guard transitions between statuses the state machine knows about, so
    // a row written before this existed can still be moved.
    if ((CASE_STATUSES as readonly string[]).includes(row.status) && row.status !== data.status) {
      assertTransition(row.status as never, data.status as never);
    }

    const patch = {
      status: data.status,
      ...(data.status === "submitted" ? { submitted_at: now, submitted_by: context.userId } : {}),
      ...(["approved", "rejected", "dismissed"].includes(data.status) ? { resolved_at: now } : {}),
    };
    const { error } = await context.supabase
      .from("removal_cases")
      .update(patch)
      .eq("id", data.id)
      .eq("workspace_id", workspaceId);
    if (error) throw error;

    // A status change made from the UI is a person's assertion about the case,
    // so it is recorded as exactly that. It deliberately does not carry
    // `reviewVisible`, which means it can never establish a verified outcome:
    // the outcome column still reads "unverified" until a recheck is recorded.
    const phase = data.status === "submitted" ? ("SUBMISSION" as const) : ("AFTER" as const);
    const next = appendEntry(ledger as never, {
      phase,
      at: now,
      actor: { kind: "user", id: context.userId },
      observation: `A workspace member set the case status to "${data.status}".`,
      source: { type: "user_assertion", detail: "Status changed from the removals screen; not a provider confirmation." },
    });
    const committed = await commitLedger(context, workspaceId, data.id, evidence, next);

    return { ok: true, outcome: committed.outcome, outcomeAt: committed.outcomeAt };
  });

async function caseWithReview(context: Ctx, workspaceId: string, caseId: string) {
  const { data, error } = await context.supabase
    .from("removal_cases")
    .select(
      "id, review_id, violation_type, rationale, appeal_text, reviews(author, rating, body, platform, location_name, external_id)",
    )
    .eq("id", caseId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.reviews) throw new Error("That removal case no longer exists.");
  return data as any;
}

/** Writes the public holding reply that goes out while the removal appeal is pending. */
export const draftRemovalReply = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ caseId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const workspaceId = await workspaceIdFor(context);
    const row = await caseWithReview(context, workspaceId, data.caseId);
    const review = row.reviews;

    const { data: brand } = await context.supabase
      .from("brand_settings")
      .select("brand_name, industry, reply_tone, reply_signature")
      .eq("workspace_id", workspaceId)
      .limit(1)
      .maybeSingle();

    const system = [
      `You write public replies to reviews on behalf of ${brand?.brand_name ?? "the business"}, a ${brand?.industry ?? "multi-location business"}.`,
      `Tone: ${brand?.reply_tone ?? "calm-professional"}. Sign off as: ${brand?.reply_signature ?? "the customer care team"}.`,
      "This review appears to break platform content policy and a removal request has been raised with the platform.",
      "Rules: 35-70 words. Stay calm and factual. State politely that the business has no record matching this experience and that the review has been reported to the platform for review.",
      "Never insult the reviewer, never accuse them of lying in harsh terms, never mention internal tools, AI, confidence scores or legal action. Never invent facts.",
      "Return only the reply text, with no quotes or commentary.",
    ].join("\n");

    const prompt = [
      `Platform: ${review.platform}`,
      `Location: ${review.location_name}`,
      `Reviewer: ${review.author}`,
      `Rating: ${review.rating}/5`,
      `Review: ${review.body}`,
      `Policy issue: ${row.violation_type}`,
      `Why: ${row.rationale}`,
    ].join("\n");

    const { runAiText } = await import("@/lib/ai-gateway.server");
    const { output } = await runAiText(system, prompt);
    return { reply: output.trim() };
  });

/**
 * Publishes the reply publicly. When the review came from a connected Google
 * Business Profile the reply is posted to Google; otherwise it is recorded only.
 */
export const publishRemovalReply = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ caseId: z.string().uuid(), reply: z.string().min(5).max(4000) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const workspaceId = await workspaceIdFor(context);
    const row = await caseWithReview(context, workspaceId, data.caseId);
    const review = row.reviews;
    let postedToGoogle = false;

    if (review.platform === "google" && typeof review.external_id === "string" && review.external_id.startsWith("gbp:")) {
      const { data: connection, error: connectionError } = await context.supabase
        .from("google_business_connections")
        .select("access_token_ciphertext,refresh_token_ciphertext,token_expires_at,status")
        .eq("workspace_id", workspaceId)
        .maybeSingle();
      if (connectionError) throw connectionError;
      if (!connection || connection.status !== "connected") {
        throw new Error("Connect Google Business Profile before sending a reply to Google.");
      }
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { usableAccessToken, postGoogleReviewReply } = await import("./google-business-sync.server");
      const token = await usableAccessToken(supabaseAdmin, workspaceId, connection);
      await postGoogleReviewReply(token, review.external_id, data.reply);
      postedToGoogle = true;
    }

    const now = new Date().toISOString();
    const { error: reviewError } = await context.supabase
      .from("reviews")
      .update({ reply: data.reply, status: "replied", replied_at: now, replied_by: context.userId })
      .eq("id", row.review_id)
      .eq("workspace_id", workspaceId);
    if (reviewError) throw reviewError;

    return { postedToGoogle };
  });

// ---------------------------------------------------------------------------
// Verification loop: BEFORE -> SUBMISSION -> RESPONSE -> RECHECK -> AFTER
//
// Each of the functions below appends one entry to the case ledger and reseals
// the evidence package. The outcome column is always recomputed from the ledger
// by `resealWithLedger`, never taken from the caller, so a case cannot be marked
// removed because a report was filed, because the provider claimed it, or
// because a model predicted it. Only a recheck observation can do that.
// ---------------------------------------------------------------------------

/** Loads a case together with its ledger, creating an empty ledger if absent. */
async function caseLedger(context: Ctx, workspaceId: string, caseId: string) {
  const { data, error } = await context.supabase
    .from("removal_cases")
    .select("id, status, route, evidence, outcome, review_id")
    .eq("id", caseId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("That removal case no longer exists.");
  const evidence = data.evidence && typeof data.evidence === "object" ? data.evidence : null;
  const ledger = Array.isArray(evidence?.verification?.ledger) ? evidence.verification.ledger : [];
  return { row: data as any, evidence, ledger };
}

/**
 * Writes a ledger entry and the recomputed outcome back to the case. The status
 * is only changed when the caller asks for it, so existing behaviour is
 * untouched for callers that only record evidence.
 */
async function commitLedger(
  context: Ctx,
  workspaceId: string,
  caseId: string,
  evidence: any,
  ledger: unknown[],
  status?: string,
) {
  const { resealWithLedger } = await import("@/lib/removal/evidence.server");

  // A case created before the evidence package existed has nothing to reseal.
  // The ledger is still recorded, and the outcome is still derived from it.
  let nextEvidence = evidence;
  let outcome: string;
  let outcomeAt: string | null;
  if (evidence) {
    nextEvidence = resealWithLedger(evidence, ledger as never);
    outcome = nextEvidence.verification.outcome;
    outcomeAt = nextEvidence.verification.outcomeAt;
  } else {
    const { resolveOutcome } = await import("@/lib/removal/lifecycle");
    const resolved = resolveOutcome(ledger as never);
    outcome = resolved.outcome;
    outcomeAt = resolved.outcomeAt;
    nextEvidence = { schema: "seovale.evidence.legacy_ledger_only", verification: { ledger } };
  }

  const { error } = await context.supabase
    .from("removal_cases")
    .update({
      evidence: nextEvidence,
      outcome,
      outcome_at: outcomeAt,
      ...(status ? { status } : {}),
    })
    .eq("id", caseId)
    .eq("workspace_id", workspaceId);
  if (error) throw error;
  return { outcome, outcomeAt };
}

/** Returns the evidence package, detected routes and verification ledger. */
export const getRemovalCaseDetail = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ caseId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const workspaceId = await workspaceIdFor(context);
    const { row, evidence, ledger } = await caseLedger(context, workspaceId, data.caseId);
    const { phaseProgress, providerDecision, resolveOutcome, nextRecheckDue } = await import("@/lib/removal/lifecycle");
    const resolved = resolveOutcome(ledger as never);
    return {
      id: row.id,
      status: row.status as string,
      route: (row.route as string | null) ?? null,
      evidence,
      routes: Array.isArray(evidence?.routes) ? evidence.routes : [],
      ledger,
      phases: phaseProgress(ledger as never),
      providerDecision: providerDecision(ledger as never),
      outcome: resolved.outcome,
      outcomeAt: resolved.outcomeAt,
      outcomeBasis: resolved.basis,
      nextRecheckDue: nextRecheckDue(ledger as never),
    };
  });

/**
 * Records that a submission actually left the system or was filed by a person
 * through the provider interface. Recording a submission never establishes an
 * outcome.
 */
export const recordSubmission = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        caseId: z.string().uuid(),
        route: z.string().min(3).max(64),
        /** How it was filed. `manual_provider_interface` for a human submission. */
        channel: z.string().min(3).max(120),
        /** What was actually submitted, in the submitter's own words. */
        observation: z.string().min(3).max(2000),
        /** A reference the provider issued at submission time, if any. */
        reference: z.string().max(200).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const workspaceId = await workspaceIdFor(context);
    const { row, evidence, ledger } = await caseLedger(context, workspaceId, data.caseId);
    const { appendEntry, assertTransition } = await import("@/lib/removal/lifecycle");
    const { ROUTES } = await import("@/lib/removal/routes");
    if (!(ROUTES as readonly string[]).includes(data.route)) {
      throw new Error(`"${data.route}" is not one of the legitimate routes this system recognises.`);
    }
    if (row.status !== "submitted") assertTransition(row.status, "submitted");

    const next = appendEntry(ledger as never, {
      phase: "SUBMISSION",
      at: new Date().toISOString(),
      actor: { kind: "user", id: context.userId },
      observation: data.observation,
      source: {
        type: "submission_record",
        detail: `route=${data.route}; channel=${data.channel}${data.reference ? `; provider reference=${data.reference}` : ""}`,
      },
    });
    const result = await commitLedger(context, workspaceId, data.caseId, evidence, next, "submitted");
    return { ...result, phase: "SUBMISSION" as const };
  });

/**
 * Records what the provider actually answered. The answer is stored verbatim and
 * is never generated, paraphrased or predicted. A provider claiming removal does
 * not mark the review removed — a recheck has to confirm it.
 */
export const recordProviderResponse = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        caseId: z.string().uuid(),
        /** Where the answer arrived from, e.g. provider_interface, email, api. */
        channel: z.string().min(3).max(120),
        /** The provider's answer exactly as received. */
        verbatim: z.string().min(1).max(8000),
        decision: z.enum(["accepted", "rejected", "no_response"]),
        /** Only a reference the provider itself issued. Never invented. */
        reference: z.string().max(200).optional(),
        receivedAt: z.string().datetime().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const workspaceId = await workspaceIdFor(context);
    const { evidence, ledger } = await caseLedger(context, workspaceId, data.caseId);
    const { appendEntry } = await import("@/lib/removal/lifecycle");
    const receivedAt = data.receivedAt ?? new Date().toISOString();

    const next = appendEntry(ledger as never, {
      phase: "RESPONSE",
      at: receivedAt,
      actor: { kind: "provider", id: null },
      observation: `The provider answered: ${data.decision}.`,
      source: { type: "provider_response", detail: `channel=${data.channel}` },
      providerResponse: {
        channel: data.channel,
        verbatim: data.verbatim,
        reference: data.reference ?? null,
        decision: data.decision,
        receivedAt,
      },
    });
    const result = await commitLedger(context, workspaceId, data.caseId, evidence, next);
    return { ...result, phase: "RESPONSE" as const };
  });

/**
 * Records a recheck: a fresh observation of whether the review is still there.
 * This is the only input that can establish a verified outcome.
 *
 * `reviewVisible` must come from an actual observation. `null` means the recheck
 * could not be carried out, which establishes nothing and is stored as such.
 */
export const recordRecheckResult = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        caseId: z.string().uuid(),
        reviewVisible: z.boolean().nullable(),
        /** How the observation was made, so it can be re-checked by a person. */
        method: z.string().min(3).max(200),
        observation: z.string().min(3).max(2000),
        observedAt: z.string().datetime().optional(),
        /** Set true to also close the case once the recheck settles it. */
        closeCase: z.boolean().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const workspaceId = await workspaceIdFor(context);
    const { row, evidence, ledger } = await caseLedger(context, workspaceId, data.caseId);
    const { appendEntry, resolveOutcome, canTransition } = await import("@/lib/removal/lifecycle");
    const observedAt = data.observedAt ?? new Date().toISOString();

    let next = appendEntry(ledger as never, {
      phase: "RECHECK",
      at: observedAt,
      actor: { kind: "user", id: context.userId },
      observation: data.observation,
      source: { type: "recheck_observation", detail: data.method },
      reviewVisible: data.reviewVisible,
    });

    const resolved = resolveOutcome(next as never);

    // AFTER is recorded only once the recheck actually settled the question.
    let status: string | undefined;
    if (data.closeCase && resolved.outcome !== "unverified") {
      next = appendEntry(next as never, {
        phase: "AFTER",
        at: observedAt,
        actor: { kind: "system", id: null },
        observation: resolved.basis,
        source: { type: "derived_from_recheck", detail: `outcome=${resolved.outcome}` },
      });
      const target = resolved.outcome === "removed" ? "approved" : "rejected";
      if (canTransition(row.status, target)) status = target;
    }

    const result = await commitLedger(context, workspaceId, data.caseId, evidence, next, status);
    return { ...result, phase: "RECHECK" as const, basis: resolved.basis, statusChangedTo: status ?? null };
  });
