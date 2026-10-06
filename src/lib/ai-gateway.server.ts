// Server-only helper that connects the AI SDK to the Lovable AI Gateway.
import { createOpenAI } from "@ai-sdk/openai";

export const AI_MODEL = "openai/gpt-6-astra";

/** Captures and resends the gateway run id for the lifetime of one request. */
export function createLovableAiGatewayRunIdFetch(initialRunId?: string | undefined) {
  let runId = initialRunId;
  const wrapped: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    if (runId) headers.set("X-Lovable-AIG-Run-ID", runId);
    const res = await fetch(input, { ...init, headers });
    const returned = res.headers.get("X-Lovable-AIG-Run-ID");
    if (returned) runId = returned;
    return res;
  };
  return {
    fetch: wrapped,
    get runId() {
      return runId;
    },
  };
}

/** Creates the Responses-API provider bound to the Lovable AI Gateway. */
export function createGateway() {
  const key = process.env["LOVABLE_API_KEY"];
  if (!key) throw new Error("AI is not configured for this project.");
  const runIdFetch = createLovableAiGatewayRunIdFetch();
  const provider = createOpenAI({
    baseURL: "https://ai.gateway.lovable.dev/v1",
    apiKey: key,
    headers: {
      "Lovable-API-Key": key,
      "X-Lovable-AIG-SDK": "vercel-ai-sdk",
    },
    fetch: runIdFetch.fetch,
  });
  return { provider, runIdFetch };
}

export const REASONING_OPTIONS = {
  forceReasoning: true,
  reasoningEffort: "low",
  reasoningSummary: "auto",
  store: false,
  include: ["reasoning.encrypted_content"],
} as const;

/** Model used when falling back to the account's own OpenAI key. */
export const FALLBACK_MODEL = "gpt-4.1";
/** Model used when falling back to the account's own Anthropic key. */
export const CLAUDE_MODEL = "claude-sonnet-4-5";

/**
 * Direct OpenAI provider built from the project's own OPENAI_API_KEY.
 * Used only as a backup when the Lovable AI Gateway call fails.
 */
export function createDirectOpenAI() {
  const key = process.env["OPENAI_API_KEY"];
  if (!key) return null;
  return createOpenAI({ apiKey: key });
}

/** Direct Anthropic provider built from the project's own ANTHROPIC_API_KEY. */
export async function createDirectAnthropic() {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (!key) return null;
  const { createAnthropic } = await import("@ai-sdk/anthropic");
  return createAnthropic({ apiKey: key });
}

export interface AiTextResult {
  output: string;
  model: string;
  provider: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * Runs one text generation, trying Lovable AI first and falling back to the
 * project's own OpenAI key, then its Anthropic key, so AI never goes dark.
 * Returns the real model, latency and token usage the provider reported.
 */
export async function runAiText(system: string, prompt: string): Promise<AiTextResult> {
  const { streamText } = await import("ai");
  const errors: unknown[] = [];

  const finish = async (result: any, model: string, provider: string, started: number): Promise<AiTextResult> => {
    const output = (await result.text).trim();
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    try {
      const usage = await result.usage;
      inputTokens = usage?.inputTokens ?? null;
      outputTokens = usage?.outputTokens ?? null;
    } catch {
      // Usage is optional metadata; never fail a good answer over it.
    }
    return { output, model, provider, latencyMs: Date.now() - started, inputTokens, outputTokens };
  };

  // Hard ceiling per attempt: without it a hanging provider stream can keep a
  // scan in the "ai" stage until the 15-minute stale-scan backstop fires.
  const AI_TIMEOUT_MS = 120_000;

  const gatewayStarted = Date.now();
  try {
    const { provider } = createGateway();
    const result = streamText({
      model: provider.responses(AI_MODEL),
      system,
      prompt,
      abortSignal: AbortSignal.timeout(AI_TIMEOUT_MS),
      providerOptions: { openai: { ...REASONING_OPTIONS } },
    });
    return await finish(result, AI_MODEL, "lovable_ai", gatewayStarted);
  } catch (error) {
    errors.push(error);
  }

  const openai = createDirectOpenAI();
  if (openai) {
    const started = Date.now();
    try {
      const result = streamText({
        model: openai.responses(FALLBACK_MODEL),
        system,
        prompt,
        abortSignal: AbortSignal.timeout(AI_TIMEOUT_MS),
        providerOptions: { openai: { store: false } },
      });
      return await finish(result, FALLBACK_MODEL, "openai", started);
    } catch (error) {
      errors.push(error);
    }
  }

  const anthropic = await createDirectAnthropic();
  if (anthropic) {
    const started = Date.now();
    try {
      const result = streamText({
        model: anthropic(CLAUDE_MODEL),
        system,
        prompt,
        abortSignal: AbortSignal.timeout(AI_TIMEOUT_MS),
      });
      return await finish(result, CLAUDE_MODEL, "anthropic", started);
    } catch (error) {
      errors.push(error);
    }
  }

  // Every provider failed. Report which one failed and why, in order, so the
  // stored ai_runs row names the real blocker instead of the last stream error.
  if (errors.length) {
    const tried = ["lovable_ai", ...(createDirectOpenAI() ? ["openai"] : []), ...(anthropic ? ["anthropic"] : [])];
    const detail = errors
      .map((error, index) => `${tried[index] ?? "provider"}: ${error instanceof Error ? error.message : String(error)}`)
      .join(" | ");
    throw new Error(`Every AI provider failed — ${detail}`);
  }
  throw new Error("AI is not configured for this project.");
}

/** Strips a ```json fence if the model wrapped its answer in one. */
function unfence(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1] ?? text;
  const start = body.search(/[{[]/);
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  return start >= 0 && end > start ? body.slice(start, end + 1) : body.trim();
}


export class AiValidationError extends Error {}

/**
 * Runs a JSON generation and validates it before the result is allowed
 * anywhere near stored data. Malformed or unfaithful output is retried once
 * with the validation error fed back; after that the caller is told the AI
 * step failed. Nothing is ever silently accepted or invented.
 */
export async function runAiJson<T>(
  system: string,
  prompt: string,
  validate: (value: unknown) => T,
  attempts = 2,
): Promise<{ value: T; raw: string } & Omit<AiTextResult, "output">> {
  let lastError: unknown = null;
  let feedback = "";

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await runAiText(
      `${system}\n\nReply with a single JSON object and nothing else. No prose, no markdown fence.`,
      feedback ? `${prompt}\n\nYour previous reply was rejected: ${feedback}\nReturn corrected JSON.` : prompt,
    );
    try {
      const parsed = JSON.parse(unfence(result.output));
      const value = validate(parsed);
      const { output, ...rest } = result;
      return { value, raw: output, ...rest };
    } catch (error) {
      lastError = error;
      feedback = error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400);
    }
  }

  throw new AiValidationError(
    `The AI reply did not pass validation after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

