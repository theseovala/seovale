import { describe, expect, test } from "bun:test";
import { jsonValue, record } from "../src/lib/backend-types";
import { extractIdentity } from "../src/lib/scan/collectors.server";
import { jsonbSafe } from "../src/lib/scan/engine.server";
import { analyze } from "../src/lib/scan/analyze.server";
import { parseActionPlan } from "../src/lib/scan/ai-analysis.server";
import { buildEvidencePackage, verifyPackageIntegrity } from "../src/lib/removal/evidence.server";
import { storedEvidence } from "../src/lib/removal/stored-payloads.server";
import type { Ledger } from "../src/lib/removal/lifecycle";

const ledger: Ledger = [
  {
    phase: "RECHECK",
    at: "2026-10-08T12:00:00.000Z",
    actor: { kind: "user", id: "fixture-user" },
    observation: "Fixture observation: review is still visible.",
    source: { type: "fixture", detail: "in-memory test" },
    reviewVisible: true,
  },
];

describe("Backend payload guards", () => {
  test("JSON storage conversion keeps supported values and JSON serialization semantics", () => {
    expect(
      jsonValue({ text: "kept", omitted: undefined, numbers: [1, NaN], nested: null }),
    ).toEqual({ text: "kept", numbers: [1, null], nested: null });
    expect(record(null)).toEqual({});
    expect(record(["not", "a", "record"])).toEqual({});
  });

  test("JSONB sanitization removes only NUL from values and keys recursively", () => {
    expect(
      jsonbSafe({
        ["ke\u0000y"]: "a\u0000b\t\n\r\u0001😀",
        array: ["\u0000", { nested: "x\u0000y" }, false, null],
      }),
    ).toEqual({
      key: "ab\t\n\r\u0001😀",
      array: ["", { nested: "xy" }, false, null],
    });
  });

  test("identity extraction ignores primitive JSON-LD and reads valid graph nodes", () => {
    const identity = extractIdentity(`
      <script type="application/ld+json">null</script>
      <script type="application/ld+json">{"@graph":false}</script>
      <script type="application/ld+json">
      {"@graph":[null,{"@type":"LocalBusiness","name":"Fixture business",
        "telephone":"+1 555 0100","address":{"streetAddress":"Fixture street","addressLocality":"Fixture city"},
        "sameAs":["https://example.com/",12]}]}
      </script>`);
    expect(identity.name).toBe("Fixture business");
    expect(identity.phone).toBe("+1 555 0100");
    expect(identity.address).toBe("Fixture street, Fixture city");
    expect(identity.sameAs).toEqual(["https://example.com/"]);
  });

  test("analysis preserves concrete measurements from a valid collected page", () => {
    const result = analyze([
      {
        source: "http",
        provider: null,
        status: "completed",
        durationMs: 100,
        raw: {
          httpStatus: 503,
          bytes: 120,
          finalUrl: "https://example.com/",
          html: "",
          headers: {},
        },
      },
    ]);
    expect(result.metrics.find((metric) => metric.metricKey === "http_status")?.valueNumeric).toBe(
      503,
    );
    expect(result.metrics.find((metric) => metric.metricKey === "page_bytes")?.valueNumeric).toBe(
      120,
    );
    expect(result.findings.some((finding) => finding.evidence?.["httpStatus"] === 503)).toBe(true);
  });

  test("stored action plans expose only validated items", () => {
    const plan = [
      {
        findingCode: "fixture",
        problem: "Fixture problem",
        impact: "Fixture impact",
        action: "Fixture action",
        expectedObjective: "Fixture objective",
      },
    ];
    expect(parseActionPlan(plan)).toEqual(plan);
    expect(parseActionPlan({ action: "not an array" })).toEqual([]);
    expect(parseActionPlan([{ ...plan[0], findingCode: 12 }])).toEqual([]);
  });

  test("legacy ledgers retain their real observations without inventing an evidence package", () => {
    expect(
      storedEvidence({ schema: "seovale.evidence.legacy_ledger_only", verification: { ledger } }),
    ).toEqual({ evidence: null, ledger });
    expect(storedEvidence(null)).toEqual({ evidence: null, ledger: [] });
  });

  test("malformed observations cannot establish an outcome", () => {
    expect(() =>
      storedEvidence({
        verification: { ledger: [{ ...ledger[0], reviewVisible: "false" }] },
      }),
    ).toThrow("Stored verification ledger is malformed");
  });

  test("valid full evidence packages retain the original seal and verified outcome", () => {
    const evidence = buildEvidencePackage({
      review: {
        id: "fixture-review",
        platform: "trustpilot",
        externalId: "fixture-external",
        author: "Fixture reviewer",
        rating: 1,
        body: "Fixture unrelated advertising.",
        externalCreatedAt: "2026-10-07T12:00:00.000Z",
        url: "https://example.com/review/fixture",
        urlPrecision: "review_permalink",
        urlDerivation: "provider_supplied",
        urlPatternSource: null,
      },
      finding: {
        violationType: "spam_or_advertising",
        confidence: 0.9,
        explanation: "Fixture advertising.",
        model: "fixture",
      },
      routes: [],
      ledger,
      legalSourceConnected: false,
      now: new Date("2026-10-08T12:00:00.000Z"),
    });
    const loaded = storedEvidence(jsonValue(evidence));
    expect(loaded.evidence).toEqual(evidence);
    expect(loaded.evidence?.verification.outcome).toBe("retained");
    expect(loaded.evidence && verifyPackageIntegrity(loaded.evidence)).toBe(true);
  });
});
