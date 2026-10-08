import { z } from "zod";
import { record } from "../backend-types";
import { EVIDENCE_SCHEMA, validateEvidencePackage, type EvidencePackage } from "./evidence.server";
import { PHASES, PROVIDER_DECISIONS, type Ledger, type LedgerEntry } from "./lifecycle";
import { ROUTES } from "./routes";

const source = z.object({ type: z.string(), detail: z.string() });
const ledgerEntry = z.object({
  phase: z.enum(PHASES),
  at: z.string(),
  actor: z.object({ kind: z.enum(["system", "user", "provider"]), id: z.string().nullable() }),
  observation: z.string(),
  source,
  reviewVisible: z.boolean().nullable().optional(),
  providerResponse: z
    .object({
      channel: z.string(),
      verbatim: z.string(),
      reference: z.string().nullable(),
      decision: z.enum(PROVIDER_DECISIONS),
      receivedAt: z.string(),
    })
    .optional(),
});
const evidenceSource = source.extend({ url: z.string().nullable(), retrievedAt: z.string() });
const packageSchema = z.object({
  schema: z.literal(EVIDENCE_SCHEMA),
  assembledAt: z.string(),
  review: z.object({
    id: z.string(),
    platform: z.string(),
    externalId: z.string().nullable(),
    url: z.string().nullable(),
    urlPrecision: z.enum(["review_permalink", "location_reviews", "unavailable"]),
    urlDerivation: z.string(),
    author: z.string(),
    rating: z.number(),
    capturedBody: z.string(),
    bodySha256: z.string(),
    externalCreatedAt: z.string().nullable(),
  }),
  finding: z.object({
    violationType: z.string(),
    confidence: z.number(),
    explanation: z.string(),
    classifier: z.object({ kind: z.literal("ai_classification"), model: z.string().nullable() }),
  }),
  items: z.array(
    z.object({
      id: z.string(),
      claim: z.string(),
      value: z.string(),
      source: evidenceSource,
      timestamp: z.string(),
      confidence: z.number(),
      explanation: z.string(),
    }),
  ),
  routes: z.array(
    z.object({
      route: z.enum(ROUTES),
      rank: z.number(),
      actionState: z.enum([
        "PROVIDER_API_AVAILABLE",
        "PROVIDER_APPROVAL_REQUIRED",
        "MANUAL_ACTION_REQUIRED",
        "LEGAL_SOURCE_REQUIRED",
      ]),
      policyBasis: z.object({
        ruleName: z.string(),
        source: z.union([
          z.literal("POLICY_SOURCE_REQUIRED"),
          z.object({
            url: z.string(),
            retrievedAt: z.string(),
            jurisdiction: z.string().nullable(),
          }),
        ]),
      }),
      reason: z.string(),
      blockedBy: z.string().nullable(),
    }),
  ),
  legal: z.object({
    status: z.enum(["LEGAL_SOURCE_REQUIRED", "LEGAL_SOURCE_CONNECTED"]),
    jurisdiction: z.string().nullable(),
    authorities: z.array(
      z.object({
        name: z.string(),
        citation: z.string(),
        url: z.string(),
        retrievedAt: z.string(),
        jurisdiction: z.string(),
      }),
    ),
  }),
  verification: z.object({
    phases: z.object({
      BEFORE: z.boolean(),
      SUBMISSION: z.boolean(),
      RESPONSE: z.boolean(),
      RECHECK: z.boolean(),
      AFTER: z.boolean(),
    }),
    outcome: z.string(),
    outcomeAt: z.string().nullable(),
    outcomeBasis: z.string(),
    providerDecision: z.string(),
    ledger: z.array(ledgerEntry),
  }),
  integrity: z.object({ packageSha256: z.string() }),
});

function isLedgerEntry(value: unknown): value is LedgerEntry {
  return ledgerEntry.safeParse(value).success;
}

function isEvidencePackage(value: unknown): value is EvidencePackage {
  return packageSchema.safeParse(value).success;
}

export function storedEvidence(value: unknown): {
  evidence: EvidencePackage | null;
  ledger: Ledger;
} {
  if (value === null || value === undefined) return { evidence: null, ledger: [] };
  const body = record(value);
  const verification = record(body["verification"]);
  const entries = verification["ledger"];
  const ledger: Ledger = [];
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (!isLedgerEntry(entry)) throw new Error("Stored verification ledger is malformed.");
      ledger.push(entry);
    }
  }
  if (body["schema"] === EVIDENCE_SCHEMA) {
    if (!isEvidencePackage(value)) throw new Error("Stored evidence package is malformed.");
    validateEvidencePackage(value);
    return { evidence: value, ledger };
  }
  return { evidence: null, ledger };
}
