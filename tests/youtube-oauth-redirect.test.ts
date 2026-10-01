import { describe, expect, test } from "bun:test";
import { integrationRedirectUri } from "../src/lib/integrations/registry";

describe("integration redirect URIs", () => {
  test("YouTube uses the registered production callback", () => {
    expect(integrationRedirectUri("https://seovale.com", "youtube")).toBe(
      "https://seovale.com/api/public/youtube/callback",
    );
  });

  test("other integrations keep the shared callback", () => {
    expect(integrationRedirectUri("https://seovale.com", "google_gmail")).toBe(
      "https://seovale.com/api/public/integrations/callback",
    );
  });
});
