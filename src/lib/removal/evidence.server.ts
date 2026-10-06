/**
 * Structured evidence package.
 *
 * Every removal case carries one of these. Its shape follows the rule the owner
 * set: Finding → Evidence → Source → Timestamp → Confidence → Explanation, with
 * every item traceable to something the system actually observed.
 *
 * Two structural guarantees, not conventions:
 *
 *  1. The AI cannot contribute a source. `buildEvidencePackage` takes the review
 *     text, identifiers, URL and timestamps from the stored row only. The model
 *     supplies exactly two things — a violation label drawn from a fixed list
 *     and a written explanation — and both are recorded as an AI claim with the
 *     model named. Review text, URLs, policy sources, provider responses and
 *     outcomes are never read from model output.
 *
 *  2. The package is validated before it is returned. A missing source, an
 *     unparseable timestamp or a confidence outside 0-1 throws instead of being
 *     stored, so a half-assembled package cannot reach the database.
 *
 * The package is hashed so it can be shown to be unchanged since assembly.
 */

import { createHash } from "node:crypto";
import type { DetectedRoute } from "./routes";
import type { Ledger, Phase } from "./lifecycle";
import { phaseProgress, providerDecision, resolveOutcome } from "./lifecycle";
import type { ReviewUrlPrecision } from "./review-url";

export const EVIDENCE_SCHEMA = "seovale.evidence.v1";

export type EvidenceSource = {
  /** Where the fact came from, e.g. provider_api, stored_review_row, ai_classification. */
  type: string;
  /** Enough detail for a person to re-check it. */
  detail: string;
  /** Only set when a real document backs the item. */
  url: string | null;
  retrievedAt: string;
};

export type EvidenceItem = {
  id: string;
  /** The finding this item supports. */
  claim: string;
  /** The observed fact itself. */
  value: string;
  source: EvidenceSource;
  timestamp: string;
  /** 0-1. 1 means directly observed; lower means inferred. */
  confidence: number;
  explanation: string;
};

export type EvidencePackage = {
  schema: typeof EVIDENCE_SCHEMA;
  assembledAt: string;
  review: {
    id: string;
    platform: string;
    externalId: string | null;
    url: string | null;
    urlPrecision: ReviewUrlPrecision;
    urlDerivation: string;
    author: string;
    rating: number;
    capturedBody: string;
    bodySha256: string;
    externalCreatedAt: string | null;
  };
  finding: {
    violationType: string;
    confidence: number;
    explanation: string;
    classifier: { kind: "ai_classification"; model: string | null };
  };
  items: EvidenceItem[];
  routes: DetectedRoute[];
  legal: {
    status: "LEGAL_SOURCE_REQUIRED" | "LEGAL_SOURCE_CONNECTED";
    jurisdiction: string | null;
    /** Stays empty until an authorised legal source supplies entries. */
    authorities: Array<{
      name: string;
      citation: string;
      url: string;
      retrievedAt: string;
      jurisdiction: string;
    }>;
  };
  verification: {
    phases: Record<Phase, boolean>;
    outcome: string;
    outcomeAt: string | null;
    outcomeBasis: string;
    providerDecision: string;
    ledger: Ledger;
  };
  integrity: { packageSha256: string };
};

/** Key-sorted JSON, so the same content always hashes to the same value. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validateItem(item: EvidenceItem, index: number): void {
  const where = `evidence item ${index} (${item.id || "no id"})`;
  if (!item.id) throw new Error(`${where}: id is required.`);
  if (!item.claim.trim()) throw new Error(`${where}: claim is required.`);
  if (!item.value.trim()) throw new Error(`${where}: value is required.`);
  if (!item.explanation.trim()) throw new Error(`${where}: explanation is required.`);
  if (!item.source?.type?.trim()) throw new Error(`${where}: source.type is required.`);
  if (!item.source?.detail?.trim()) throw new Error(`${where}: source.detail is required.`);
  if (Number.isNaN(Date.parse(item.source.retrievedAt)))
    throw new Error(`${where}: source.retrievedAt is not a date.`);
  if (Number.isNaN(Date.parse(item.timestamp)))
    throw new Error(`${where}: timestamp is not a date.`);
  if (typeof item.confidence !== "number" || item.confidence < 0 || item.confidence > 1) {
    throw new Error(`${where}: confidence must be between 0 and 1.`);
  }
}

/** Throws unless the package is complete and internally consistent. */
export function validateEvidencePackage(pkg: EvidencePackage): void {
  if (pkg.schema !== EVIDENCE_SCHEMA) throw new Error(`Unknown evidence schema: ${pkg.schema}`);
  if (Number.isNaN(Date.parse(pkg.assembledAt))) throw new Error("assembledAt is not a date.");
  if (!pkg.review.id) throw new Error("The package must name the review it is about.");
  if (!pkg.review.capturedBody.trim())
    throw new Error("The package must contain the review text as captured.");
  if (pkg.review.bodySha256 !== sha256(pkg.review.capturedBody)) {
    throw new Error("The stored review hash does not match the captured review text.");
  }
  if (!pkg.finding.violationType) throw new Error("The package must name the violation found.");
  if (pkg.items.length === 0) throw new Error("An evidence package with no items is not evidence.");
  pkg.items.forEach(validateItem);
  if (pkg.legal.status === "LEGAL_SOURCE_REQUIRED" && pkg.legal.authorities.length > 0) {
    throw new Error("Legal authorities are present while no authorised legal source is connected.");
  }
  for (const authority of pkg.legal.authorities) {
    if (!authority.url || !authority.citation || Number.isNaN(Date.parse(authority.retrievedAt))) {
      throw new Error(
        `Legal authority "${authority.name}" lacks a citation, URL or retrieval date.`,
      );
    }
  }
}

export type BuildEvidenceInput = {
  review: {
    id: string;
    platform: string;
    externalId: string | null;
    author: string;
    rating: number;
    body: string;
    externalCreatedAt: string | null;
    url: string | null;
    urlPrecision: ReviewUrlPrecision;
    urlDerivation: string;
    urlPatternSource: string | null;
  };
  /** The classifier's verdict. Only a label from the fixed list and free text. */
  finding: { violationType: string; confidence: number; explanation: string; model: string | null };
  routes: DetectedRoute[];
  ledger: Ledger;
  legalSourceConnected: boolean;
  /** Injected so the package is reproducible in a test. */
  now?: Date;
};

export function buildEvidencePackage(input: BuildEvidenceInput): EvidencePackage {
  const now = (input.now ?? new Date()).toISOString();
  const review = input.review;
  const bodySha256 = sha256(review.body);

  const items: EvidenceItem[] = [
    {
      id: "review_content",
      claim: "This is the review text the platform published.",
      value: review.body,
      source: {
        type: "stored_review_row",
        detail: `reviews.id=${review.id}, collected from the ${review.platform} integration`,
        url: null,
        retrievedAt: now,
      },
      timestamp: review.externalCreatedAt ?? now,
      confidence: 1,
      explanation:
        "Captured verbatim when the review was collected. The hash below detects any later change.",
    },
    {
      id: "review_content_hash",
      claim: "The review text has not changed since it was captured.",
      value: bodySha256,
      source: {
        type: "computed",
        detail: "SHA-256 of the captured review text",
        url: null,
        retrievedAt: now,
      },
      timestamp: now,
      confidence: 1,
      explanation:
        "Lets the platform and a reviewer confirm the report is about the text we actually saw.",
    },
    {
      id: "review_identity",
      claim: "This identifies the review on its platform.",
      value: `platform=${review.platform}; external_id=${review.externalId ?? "none"}; author=${review.author}; rating=${review.rating}`,
      source: {
        type: "provider_api",
        detail: `Identifiers returned by the ${review.platform} integration`,
        url: null,
        retrievedAt: now,
      },
      timestamp: review.externalCreatedAt ?? now,
      confidence: 1,
      explanation: "The platform needs these to locate the review it is being asked to act on.",
    },
  ];

  if (review.url) {
    items.push({
      id: "review_location",
      claim:
        review.urlPrecision === "review_permalink"
          ? "This link points at the review itself."
          : "This link points at the page the review is published on.",
      value: review.url,
      source: {
        type: review.urlDerivation,
        detail:
          review.urlDerivation === "derived_from_place_id"
            ? "Built from the place id the provider returned, using the provider's documented link format"
            : "Supplied by the provider for this review",
        url: review.urlPatternSource,
        retrievedAt: now,
      },
      timestamp: now,
      confidence: review.urlPrecision === "review_permalink" ? 1 : 0.6,
      explanation:
        review.urlPrecision === "review_permalink"
          ? "The provider supplied this link, so it resolves to the single review."
          : "The provider publishes no per-review permalink, so this resolves to the place page where the review appears. Stated at that precision rather than implying more.",
    });
  } else {
    items.push({
      id: "review_location",
      claim: "No link to the review could be produced.",
      value: "PROVIDER_DATA_UNAVAILABLE",
      source: {
        type: "provider_api",
        detail: `The ${review.platform} integration returned neither a review permalink nor a place id`,
        url: null,
        retrievedAt: now,
      },
      timestamp: now,
      confidence: 1,
      explanation:
        "Recorded as unavailable rather than guessed. A report may need the link added by hand.",
    });
  }

  items.push({
    id: "policy_classification",
    claim: `The review was classified as ${input.finding.violationType}.`,
    value: input.finding.explanation,
    source: {
      type: "ai_classification",
      detail: `Model: ${input.finding.model ?? "unrecorded"}. Given only the stored review text; the violation label is constrained to the project's fixed list.`,
      url: null,
      retrievedAt: now,
    },
    timestamp: now,
    confidence: Math.max(0, Math.min(1, input.finding.confidence)),
    explanation:
      "An assessment, not an observation. It is the model's reading of the captured text and carries the model's own confidence.",
  });

  for (const route of input.routes) {
    items.push({
      id: `policy_basis_${route.route}`,
      claim: `Route ${route.route} relies on: ${route.policyBasis.ruleName}`,
      value:
        route.policyBasis.source === "POLICY_SOURCE_REQUIRED"
          ? "POLICY_SOURCE_REQUIRED"
          : `${route.policyBasis.source.url} (retrieved ${route.policyBasis.source.retrievedAt})`,
      source:
        route.policyBasis.source === "POLICY_SOURCE_REQUIRED"
          ? {
              type: "policy_source_required",
              detail:
                "No retrieved policy document is attached, so the rule is named but not cited.",
              url: null,
              retrievedAt: now,
            }
          : {
              type: "retrieved_policy_document",
              detail: `Jurisdiction: ${route.policyBasis.source.jurisdiction ?? "not stated"}`,
              url: route.policyBasis.source.url,
              retrievedAt: route.policyBasis.source.retrievedAt,
            },
      timestamp: now,
      confidence: route.policyBasis.source === "POLICY_SOURCE_REQUIRED" ? 0 : 1,
      explanation:
        route.policyBasis.source === "POLICY_SOURCE_REQUIRED"
          ? "The rule is named from the project's own mapping. Confidence is 0 because no document has been retrieved to cite."
          : "Cited from a policy document the system retrieved and stored.",
    });
  }

  const resolved = resolveOutcome(input.ledger);

  const pkg: EvidencePackage = {
    schema: EVIDENCE_SCHEMA,
    assembledAt: now,
    review: {
      id: review.id,
      platform: review.platform,
      externalId: review.externalId,
      url: review.url,
      urlPrecision: review.urlPrecision,
      urlDerivation: review.urlDerivation,
      author: review.author,
      rating: review.rating,
      capturedBody: review.body,
      bodySha256,
      externalCreatedAt: review.externalCreatedAt,
    },
    finding: {
      violationType: input.finding.violationType,
      confidence: Math.max(0, Math.min(1, input.finding.confidence)),
      explanation: input.finding.explanation,
      classifier: { kind: "ai_classification", model: input.finding.model },
    },
    items,
    routes: input.routes,
    legal: {
      status: input.legalSourceConnected ? "LEGAL_SOURCE_CONNECTED" : "LEGAL_SOURCE_REQUIRED",
      jurisdiction: null,
      authorities: [],
    },
    verification: {
      phases: phaseProgress(input.ledger),
      outcome: resolved.outcome,
      outcomeAt: resolved.outcomeAt,
      outcomeBasis: resolved.basis,
      providerDecision: providerDecision(input.ledger),
      ledger: input.ledger,
    },
    integrity: { packageSha256: "" },
  };

  pkg.integrity.packageSha256 = sha256(stableStringify({ ...pkg, integrity: undefined }));
  validateEvidencePackage(pkg);
  return pkg;
}

/** True when the package is byte-for-byte what was sealed at assembly. */
export function verifyPackageIntegrity(pkg: EvidencePackage): boolean {
  return pkg.integrity.packageSha256 === sha256(stableStringify({ ...pkg, integrity: undefined }));
}

/**
 * Re-seals a package after the ledger moved on. The review, finding and items
 * are carried over untouched; only the verification block is recomputed, so an
 * outcome can never be written without the ledger that supports it.
 */
export function resealWithLedger(pkg: EvidencePackage, ledger: Ledger): EvidencePackage {
  const resolved = resolveOutcome(ledger);
  const next: EvidencePackage = {
    ...pkg,
    verification: {
      phases: phaseProgress(ledger),
      outcome: resolved.outcome,
      outcomeAt: resolved.outcomeAt,
      outcomeBasis: resolved.basis,
      providerDecision: providerDecision(ledger),
      ledger,
    },
    integrity: { packageSha256: "" },
  };
  next.integrity.packageSha256 = sha256(stableStringify({ ...next, integrity: undefined }));
  validateEvidencePackage(next);
  return next;
}
