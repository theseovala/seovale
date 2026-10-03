import { describe, expect, test } from "bun:test";
import { integrationRedirectUri } from "../src/lib/integrations/registry";
import { handleIntegrationCallback } from "../src/lib/integrations/callback.server";

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
    expect(integrationRedirectUri("https://seovale.com", "instagram")).toBe(
      "https://seovale.com/api/public/integrations/callback",
    );
  });

  test("callback handler rejects requests without OAuth state", async () => {
    const response = await handleIntegrationCallback(
      new Request("https://seovale.com/api/public/youtube/callback"),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("missing its state value");
  });
});
