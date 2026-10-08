import { describe, expect, test } from "bun:test";
import { assertReviewAiAllowed, isGoogleReview } from "../src/lib/google-review-privacy";
import { runRemovalScan } from "../src/lib/removal-scan.server";

describe("Google review AI exclusion", () => {
  test.each([
    { platform: "google" },
    { platform: "Google Maps" },
    { source: "google_business", platform: "unknown" },
    { source: " GOOGLE_PLACES " },
  ])("blocks Google data identified by platform or source: %j", (review) => {
    expect(isGoogleReview(review)).toBe(true);
    expect(() => assertReviewAiAllowed(review)).toThrow("cannot be sent to an AI service");
  });

  test("keeps non-Google review workflows available", () => {
    const review = { platform: "trustpilot", source: "trustpilot" };
    expect(isGoogleReview(review)).toBe(false);
    expect(() => assertReviewAiAllowed(review)).not.toThrow();
  });

  test("manual/scheduled removal scan excludes Google content before any AI call", async () => {
    const client = {
      from(table: string) {
        const result = {
          data:
            table === "reviews"
              ? [
                  {
                    id: "google-review",
                    platform: "google",
                    source: "google_places",
                    body: "Fixture only.",
                  },
                ]
              : [],
          error: null,
        };
        const query = {
          select: () => query,
          eq: () => query,
          neq: () => query,
          order: () => query,
          limit: () => Promise.resolve(result),
          then: (resolve: (value: typeof result) => unknown) =>
            Promise.resolve(result).then(resolve),
        };
        return query;
      },
    };
    expect(await runRemovalScan(client, "workspace", 20, null)).toEqual({ checked: 0, flagged: 0 });
  });
});
