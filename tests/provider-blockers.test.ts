import { describe, expect, test } from "bun:test";
import { googleFailureMessage, googleBlockerAction } from "../src/lib/integrations/provider-blockers";

describe("provider blocker diagnostics", () => {
  test("preserves Google's exact disabled-service reason", () => {
    expect(googleFailureMessage({ error: { details: [{ reason: "SERVICE_DISABLED" }] } }, "API is disabled")).toBe("SERVICE_DISABLED: API is disabled");
  });
  test("removes keys and project numbers from diagnostics", () => {
    const result = googleFailureMessage({}, "project 123456789 key https://example.test?key=AIzaSecret123");
    expect(result).not.toContain("123456789");
    expect(result).not.toContain("AIzaSecret123");
  });
  test("blocked service maps to the correct key restriction action", () => {
    expect(googleBlockerAction("url_reputation", "API_KEY_SERVICE_BLOCKED: Requests blocked")).toContain("Safe Browsing API (safebrowsing.googleapis.com) under the saved key's API restrictions");
  });
  test("does not invent an exact blocker from a generic 403", () => {
    expect(googleBlockerAction("pagespeed", "HTTP 403")).toContain("does not establish which setting is wrong");
  });
});