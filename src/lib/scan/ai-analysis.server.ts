// AI interpretation layer.
//
// The model receives the built context only, and its reply is validated
// before anything is stored: required fields, allowed severities/categories,
// and — most importantly — every referenced finding code must exist in the
// real scan data. Unfaithful or malformed replies are retried once and then
// reported as an AI failure. Nothing synthetic is ever written.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { AiValidationError, runAiJson } from "@/lib/ai-gateway.server";
import { contextHash, type ScanAiContext } from "./ai-context.server";

export const REPORT_CATEGORIES = [
  "technical_seo",
  "on_page_seo",
  "performance",
  "security",
  "website_quality",
  "business_information",
  "local_presence",
  "social_presence",
  "reviews",
  "content",
  "cross_source_consistency",
] as const;

const AnalysisSchema = z.object({
  executiveSummary: z.string().min(20),
  condition: z.enum(["healthy", "needs_attention", "critical", "insufficient_evidence"]).default("insufficient_evidence"),
  categories: z.array(
    z.object({
      category: z.enum(REPORT_CATEGORIES),
      verdict: z.enum(["good", "mixed", "poor", "data_not_available", "insufficient_evidence"]),
      note: z.string(),
      findingCodes: z.array(z.string()).default([]),
    }),
  ).default([]),
  actionPlan: z.array(
    z.object({
      findingCode: z.string(),
      problem: z.string(),
      impact: z.string(),
      action: z.string(),
      expectedObjective: z.string(),
    }),
  ).default([]),
  crossSourceNotes: z.array(z.object({ findingCode: z.string(), note: z.string() })).default([]),
  historical: z
    .object({
      note: z.string(),
      improved: z.array(z.string()).default([]),
      worsened: z.array(z.string()).default([]),
    })
    .nullable()
    .default(null),
});

export type ScanAiAnalysis = z.infer<typeof AnalysisSchema>;

const SYSTEM_PROMPT = [
  "You are a technical SEO and online-reputation analyst.",
  "The supplied JSON context is the only source of truth. It contains measurements, findings and source statuses that were actually collected.",
  "Never invent traffic, revenue, reviews, rankings, customers, competitors, API results, business information, platform connections or technical metrics.",
  "If a fact was not collected, write exactly 'DATA NOT AVAILABLE'. If the collected data is too thin to judge, write exactly 'INSUFFICIENT EVIDENCE'.",
  "Never promise guaranteed rankings, traffic, revenue or business outcomes. Describe objectives, not results.",
  "Only reference finding codes that appear in context.findings. Only use categories that have real data in the context.",
  "For every action plan item state the problem, why it matters, the action, and the objective, in plain language a business owner understands.",
  "Priorities are already calculated in the context (priorityRank); explain them, do not reorder them.",
  'Return exactly this JSON shape: {"executiveSummary": string, "condition": "healthy"|"needs_attention"|"critical"|"insufficient_evidence", "categories": [{"category": string, "verdict": "good"|"mixed"|"poor"|"data_not_available"|"insufficient_evidence", "note": string, "findingCodes": string[]}], "actionPlan": [{"findingCode": string, "problem": string, "impact": string, "action": string, "expectedObjective": string}], "crossSourceNotes": [{"findingCode": string, "note": string}], "historical": null | {"note": string, "improved": string[], "worsened": string[]}}.',
  `Allowed category values: ${REPORT_CATEGORIES.join(", ")}.`,
  "Keep the whole reply under 900 words and include at most six action plan items.",
].join(" ");

/** Rejects a reply that references data the scan never produced. */
function validateAgainstContext(context: ScanAiContext) {
  const codes = new Set(context.findings.map((finding) => finding.code));
  return (value: unknown): ScanAiAnalysis => {
    const parsed = AnalysisSchema.parse(value);
    const unknownCodes = [
      ...parsed.actionPlan.map((item) => item.findingCode),
      ...parsed.crossSourceNotes.map((item) => item.findingCode),
      ...parsed.categories.flatMap((item) => item.findingCodes),
    ].filter((code) => !codes.has(code));
    if (unknownCodes.length) {
      throw new AiValidationError(
        `These finding codes do not exist in the scan data: ${Array.from(new Set(unknownCodes)).slice(0, 8).join(", ")}. Use only codes from context.findings.`,
      );
    }
    if (!context.history && parsed.historical) {
      throw new AiValidationError("There is no previous scan in the context, so 'historical' must be null.");
    }
    return parsed;
  };
}

export interface AiAnalysisOutcome {
  status: "completed" | "failed" | "reused";
  analysis: ScanAiAnalysis | null;
  model: string | null;
  provider: string | null;
  latencyMs: number;
  contextHash: string;
  error: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * Runs the interpretation step. Identical scan data within 24 hours reuses the
 * stored answer instead of paying for the same analysis twice.
 */
export async function analyseWithAi(
  admin: SupabaseClient,
  workspaceId: string,
  userId: string | null,
  context: ScanAiContext,
): Promise<AiAnalysisOutcome> {
  const hash = await contextHash(context);
  const started = Date.now();

  const { data: cached } = await admin
    .from("ai_runs")
    .select("output,model,created_at")
    .eq("input_hash", hash)
    .eq("purpose", "scan_analysis")
    .eq("status", "completed")
    .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (cached?.output) {
    try {
      const analysis = validateAgainstContext(context)(JSON.parse(cached.output));
      return {
        status: "reused",
        analysis,
        model: cached.model,
        provider: "cache",
        latencyMs: Date.now() - started,
        contextHash: hash,
        error: null,
        inputTokens: 0,
        outputTokens: 0,
      };
    } catch {
      // A cached answer that no longer validates is discarded, never reused.
    }
  }

  try {
    const result = await runAiJson(SYSTEM_PROMPT, JSON.stringify(context), validateAgainstContext(context));
    const serialised = JSON.stringify(result.value);
    await admin.from("ai_runs").insert({
      workspace_id: workspaceId,
      user_id: userId,
      purpose: "scan_analysis",
      model: result.model,
      input_hash: hash,
      output: serialised.slice(0, 100000),
      duration_ms: result.latencyMs,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      status: "completed",
    });
    return {
      status: "completed",
      analysis: result.value,
      model: result.model,
      provider: result.provider,
      latencyMs: result.latencyMs,
      contextHash: hash,
      error: null,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    await admin.from("ai_runs").insert({
      workspace_id: workspaceId,
      user_id: userId,
      purpose: "scan_analysis",
      model: null,
      input_hash: hash,
      output: null,
      duration_ms: Date.now() - started,
      status: "failed",
      error_message: message.slice(0, 1000),
    });
    return {
      status: "failed",
      analysis: null,
      model: null,
      provider: null,
      latencyMs: Date.now() - started,
      contextHash: hash,
      error: message,
      inputTokens: null,
      outputTokens: null,
    };
  }
}
