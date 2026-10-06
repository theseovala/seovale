/**
 * Removal-case lifecycle and the verification ledger.
 *
 * The ledger is an append-only record of what actually happened to a case, in
 * five phases:
 *
 *   BEFORE      the state of the review when the case was opened
 *   SUBMISSION  a report or appeal actually left the system, or was filed by a
 *               person through the provider interface
 *   RESPONSE    what the provider actually answered, verbatim
 *   RECHECK     a fresh observation of whether the review is still there
 *   AFTER       the state of the review once the case closed
 *
 * The rule this module exists to enforce: a review is never recorded as removed
 * because a report was generated, a submission was prepared, a request was sent
 * or a model predicted it. Only a RECHECK observation can establish removal,
 * and a RECHECK outranks whatever the provider claimed.
 */

export const PHASES = ["BEFORE", "SUBMISSION", "RESPONSE", "RECHECK", "AFTER"] as const;
export type Phase = (typeof PHASES)[number];

/** The five statuses the existing removals UI already renders. Unchanged. */
export const CASE_STATUSES = ["flagged", "submitted", "approved", "rejected", "dismissed"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/**
 * Verified outcomes only. There is deliberately no value meaning "we think it
 * will be removed" or "the provider said they removed it" — those live in the
 * ledger as a provider claim, not as an outcome.
 */
export const OUTCOMES = ["unverified", "removed", "retained"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** What the provider actually decided, kept separate from the verified outcome. */
export const PROVIDER_DECISIONS = ["none", "accepted", "rejected", "no_response"] as const;
export type ProviderDecision = (typeof PROVIDER_DECISIONS)[number];

export type ProviderResponse = {
  /** How the answer arrived: the provider interface, email, an API response. */
  channel: string;
  /** The provider's answer as received. Never paraphrased, never generated. */
  verbatim: string;
  /** A provider case or reference number, only when the provider issued one. */
  reference: string | null;
  decision: ProviderDecision;
  receivedAt: string;
};

export type LedgerEntry = {
  phase: Phase;
  at: string;
  actor: { kind: "system" | "user" | "provider"; id: string | null };
  /** What was observed or done. A statement of fact, not an interpretation. */
  observation: string;
  /** Where this entry came from, so the ledger stays auditable. */
  source: { type: string; detail: string };
  /**
   * RECHECK only: whether the review was actually still visible at that moment.
   * null means the recheck could not be carried out — which is not evidence of
   * removal and is treated as such.
   */
  reviewVisible?: boolean | null;
  /** RESPONSE only. */
  providerResponse?: ProviderResponse;
};

export type Ledger = LedgerEntry[];

const ALLOWED: Record<CaseStatus, CaseStatus[]> = {
  flagged: ["submitted", "dismissed"],
  submitted: ["approved", "rejected", "dismissed"],
  approved: [],
  rejected: ["submitted", "dismissed"],
  dismissed: [],
};

/** Whether the case may move from one status to another. */
export function canTransition(from: CaseStatus, to: CaseStatus): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}

export function assertTransition(from: CaseStatus, to: CaseStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`A removal case cannot move from ${from} to ${to}.`);
  }
}

function latest(ledger: Ledger, phase: Phase): LedgerEntry | null {
  let found: LedgerEntry | null = null;
  for (const entry of ledger) {
    if (entry.phase !== phase) continue;
    if (!found || Date.parse(entry.at) >= Date.parse(found.at)) found = entry;
  }
  return found;
}

/**
 * The verified outcome, derived only from recheck evidence.
 *
 * A provider claiming removal is not enough: if the recheck still sees the
 * review, the outcome is `retained`. Equally, a provider rejection does not
 * force `retained` — if a later recheck finds the review gone, it is gone.
 */
export function resolveOutcome(ledger: Ledger): {
  outcome: Outcome;
  outcomeAt: string | null;
  basis: string;
} {
  const recheck = latest(ledger, "RECHECK");

  if (recheck && recheck.reviewVisible === false) {
    return {
      outcome: "removed",
      outcomeAt: recheck.at,
      basis: `Recheck on ${recheck.at} found the review absent. Source: ${recheck.source.type}.`,
    };
  }
  if (recheck && recheck.reviewVisible === true) {
    return {
      outcome: "retained",
      outcomeAt: recheck.at,
      basis: `Recheck on ${recheck.at} found the review still published. Source: ${recheck.source.type}.`,
    };
  }
  if (recheck) {
    return {
      outcome: "unverified",
      outcomeAt: null,
      basis: "A recheck was attempted but could not observe the review, so nothing is established.",
    };
  }

  const response = latest(ledger, "RESPONSE");
  if (response?.providerResponse) {
    return {
      outcome: "unverified",
      outcomeAt: null,
      basis: `The provider answered (${response.providerResponse.decision}), but no recheck has confirmed what happened to the review.`,
    };
  }

  const submission = latest(ledger, "SUBMISSION");
  if (submission) {
    return {
      outcome: "unverified",
      outcomeAt: null,
      basis:
        "A submission is recorded. No provider response and no recheck yet, so nothing is established.",
    };
  }

  return {
    outcome: "unverified",
    outcomeAt: null,
    basis: "No submission, response or recheck is recorded yet.",
  };
}

/** The provider's own decision, reported separately from the verified outcome. */
export function providerDecision(ledger: Ledger): ProviderDecision {
  return latest(ledger, "RESPONSE")?.providerResponse?.decision ?? "none";
}

/**
 * Guards a write of the outcome column. Refuses to record removal unless the
 * ledger actually contains a recheck that saw the review gone, whatever the
 * caller asked for.
 */
export function assertOutcomeSupported(ledger: Ledger, outcome: Outcome): void {
  if (outcome === "unverified") return;
  const resolved = resolveOutcome(ledger);
  if (resolved.outcome !== outcome) {
    throw new Error(
      `Outcome "${outcome}" is not supported by the case evidence. The ledger supports "${resolved.outcome}": ${resolved.basis}`,
    );
  }
}

/** Appends an entry, keeping the ledger ordered oldest first. */
export function appendEntry(ledger: Ledger, entry: LedgerEntry): Ledger {
  return [...ledger, entry].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Which phases have been recorded, for progress display without guessing. */
export function phaseProgress(ledger: Ledger): Record<Phase, boolean> {
  return {
    BEFORE: ledger.some((e) => e.phase === "BEFORE"),
    SUBMISSION: ledger.some((e) => e.phase === "SUBMISSION"),
    RESPONSE: ledger.some((e) => e.phase === "RESPONSE"),
    RECHECK: ledger.some((e) => e.phase === "RECHECK"),
    AFTER: ledger.some((e) => e.phase === "AFTER"),
  };
}

/**
 * When the case should next be rechecked. Providers give no completion signal,
 * so a report that got no answer still has to be looked at again.
 */
export function nextRecheckDue(ledger: Ledger, intervalHours = 72): string | null {
  const anchor =
    latest(ledger, "RECHECK") ?? latest(ledger, "RESPONSE") ?? latest(ledger, "SUBMISSION");
  if (!anchor) return null;
  const resolved = resolveOutcome(ledger);
  if (resolved.outcome === "removed") return null;
  return new Date(Date.parse(anchor.at) + intervalHours * 3_600_000).toISOString();
}
