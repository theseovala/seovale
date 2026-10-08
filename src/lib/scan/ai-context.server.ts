// AI context builder.
//
// The AI layer never sees raw provider payloads. This module turns validated,
// normalized, stored scan data into a compact structured context where every
// important fact carries its source and the time it was collected. The same
// builder produces the hash used to cache AI analysis, so identical scan data
// is never paid for twice.

import { record } from "../backend-types";

export interface ContextFinding {
  code: string;
  category: string;
  severity: string;
  title: string;
  detail: string;
  impact: number;
  confidence: string;
  priorityRank: number;
  affected: number;
  source: string;
  evidenceKeys: string[];
}

export interface ScanAiContext {
  target: { url: string; domain: string; scannedAt: string };
  score: number | null;
  business: Record<string, unknown>;
  sources: { source: string; status: string; collectedAt: string | null; error: string | null }[];
  platforms: { provider: string; status: string; relevant: boolean; detail: string }[];
  measurements: {
    category: string;
    key: string;
    value: string | number | null;
    unit: string | null;
    source: string;
  }[];
  findings: ContextFinding[];
  crossSource: { code: string; verdict: string; values: Record<string, unknown> }[];
  history: {
    previousScanAt: string | null;
    previousScore: number | null;
    newIssues: string[];
    resolvedIssues: string[];
    unchanged: number;
  } | null;
  unavailable: string[];
}

/** Stable JSON so the same data always produces the same hash. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export async function contextHash(context: ScanAiContext) {
  const encoded = new TextEncoder().encode(stableStringify(context));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export interface BuildContextInput {
  url: string;
  domain: string;
  scannedAt: string;
  score: number | null;
  identity: Record<string, unknown>;
  sources: {
    source: string;
    status: string;
    errorMessage?: string | null;
    collectedAt?: string | null;
  }[];
  platforms: { provider: string; status: string; relevant: boolean; detail: string }[];
  metrics: {
    category: string;
    metricKey: string;
    valueNumeric?: number | null;
    valueText?: string | null;
    unit?: string | null;
    source: string;
  }[];
  findings: {
    code: string;
    category: string;
    severity: string;
    title: string;
    detail: string;
    impact: number;
    source: string;
    evidence?: Record<string, unknown> | null;
    confidence: string;
    priorityRank: number;
    affected: number;
  }[];
  history: ScanAiContext["history"];
}

/** Builds the compressed, evidence-mapped context handed to the model. */
export function buildAiContext(input: BuildContextInput): ScanAiContext {
  const technical = input.sources.filter((source) => !source.source.startsWith("platform:"));
  const unavailable = [
    ...technical
      .filter((source) => source.status !== "completed")
      .map((source) => `${source.source}: ${source.status}`),
    ...input.platforms
      .filter((platform) => platform.status !== "connected")
      .map((platform) => `${platform.provider}: ${platform.status}`),
  ];

  const crossSource = input.findings
    .filter((finding) => finding.source === "cross_source")
    .map((finding) => ({
      code: finding.code,
      verdict: String(finding.evidence?.["verdict"] ?? "UNVERIFIED"),
      values: record(finding.evidence?.["values"] ?? finding.evidence),
    }));

  return {
    target: { url: input.url, domain: input.domain, scannedAt: input.scannedAt },
    score: input.score,
    business: Object.fromEntries(
      Object.entries(input.identity).filter(
        ([, value]) => value !== null && value !== undefined && value !== "",
      ),
    ),
    sources: technical.map((source) => ({
      source: source.source,
      status: source.status,
      collectedAt: source.collectedAt ?? null,
      error: source.errorMessage ?? null,
    })),
    platforms: input.platforms,
    // Measurements are deduplicated by category+key; only stored values travel.
    measurements: Array.from(
      new Map(
        input.metrics.map((metric) => [
          `${metric.category}:${metric.metricKey}`,
          {
            category: metric.category,
            key: metric.metricKey,
            value: metric.valueNumeric ?? metric.valueText ?? null,
            unit: metric.unit ?? null,
            source: metric.source,
          },
        ]),
      ).values(),
    ),
    // Findings are sent ranked and without their full evidence blobs — only the
    // evidence keys, so the model knows what proof exists without re-reading it.
    findings: input.findings
      .slice()
      .sort((a, b) => a.priorityRank - b.priorityRank)
      .map((finding) => ({
        code: finding.code,
        category: finding.category,
        severity: finding.severity,
        title: finding.title,
        detail: finding.detail.slice(0, 400),
        impact: finding.impact,
        confidence: finding.confidence,
        priorityRank: finding.priorityRank,
        affected: finding.affected,
        source: finding.source,
        evidenceKeys: Object.keys(finding.evidence ?? {}),
      })),
    crossSource,
    history: input.history,
    unavailable,
  };
}
