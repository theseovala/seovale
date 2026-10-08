// Deterministic priority engine.
//
// Priority is calculated from measurable factors only — severity, measured
// impact, how confident the detection is, how many pages/resources it affects
// and how hard it is to fix. AI never decides priority; it may only explain a
// priority that was calculated here.

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Confidence = "high" | "medium" | "low";

const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 10,
  high: 7,
  medium: 4,
  low: 2,
  info: 1,
};

const CONFIDENCE_WEIGHT: Record<Confidence, number> = {
  high: 1,
  medium: 0.75,
  low: 0.5,
};

/**
 * How hard the fix normally is. Lower effort means the issue is promoted,
 * because it is cheap to resolve for the same benefit.
 */
const EFFORT_BY_CATEGORY: Record<string, number> = {
  seo: 1, // meta tags, titles, headings — content edits
  content: 1,
  crawl: 1.2,
  business: 1.2,
  consistency: 1.2,
  security: 1.5,
  dns: 1.5,
  performance: 2,
  domain: 2,
};

export interface PrioritizableFinding {
  code: string;
  category: string;
  severity: string;
  impact: number;
  source: string;
  evidence?: Record<string, unknown> | null;
}

export interface PriorityResult {
  code: string;
  confidence: Confidence;
  affected: number;
  priorityScore: number;
  priorityRank: number;
}

/** Deterministic confidence: measured data is high, compared/reported data is lower. */
export function confidenceOf(finding: PrioritizableFinding): Confidence {
  if (finding.source === "cross_source") {
    const verdict = String(finding.evidence?.["verdict"] ?? "");
    if (verdict === "MISMATCH") return "medium";
    if (verdict === "UNVERIFIED" || verdict === "MISSING") return "low";
    return "medium";
  }
  if (finding.source === "ai") return "low";
  return "high";
}

/** How many concrete resources the evidence names (pages, links, profiles). */
export function affectedCount(finding: PrioritizableFinding): number {
  const evidence = (finding.evidence ?? {}) as Record<string, unknown>;
  for (const key of ["pages", "brokenLinks", "urls", "profileLinks", "images"]) {
    const value = evidence[key];
    if (Array.isArray(value) && value.length) return value.length;
  }
  return 1;
}

/**
 * Ranks findings. The score is comparable across scans because every factor
 * comes from stored data, never from a model.
 */
export function prioritize(findings: PrioritizableFinding[]): PriorityResult[] {
  const scored = findings.map((finding) => {
    const severity = SEVERITY_WEIGHT[finding.severity as Severity] ?? 1;
    const confidence = confidenceOf(finding);
    const affected = affectedCount(finding);
    const effort = EFFORT_BY_CATEGORY[finding.category] ?? 1.5;
    // Frequency is dampened so one page with 30 broken links cannot dwarf a
    // site-wide critical issue.
    const frequency = 1 + Math.log10(affected);
    const raw =
      ((severity * 2 + Math.max(finding.impact, 1)) * CONFIDENCE_WEIGHT[confidence] * frequency) /
      effort;
    return {
      code: finding.code,
      confidence,
      affected,
      priorityScore: Math.round(raw * 100) / 100,
      priorityRank: 0,
    };
  });

  scored
    .slice()
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .forEach((item, index) => {
      item.priorityRank = index + 1;
    });

  return scored;
}
