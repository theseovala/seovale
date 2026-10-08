import { describe, expect, test } from "bun:test";
import { inspectArtifactEntries } from "../src/lib/license/operations.server";

describe("License artifact source-path inspection", () => {
  test("allows the client SDK source required to build the application", () => {
    expect(
      inspectArtifactEntries([
        "src/integrations/supabase/client.ts",
        "src/integrations/supabase/auth-middleware.ts",
        "src/integrations/supabase/types.ts",
      ]).passed,
    ).toBe(true);
  });

  test("rejects only the root migration directory rather than nested SDK source", () => {
    const entries = [
      "supabase",
      "supabase/migrations/fixture.sql",
      "src/integrations/supabase/client.ts",
    ];
    expect(inspectArtifactEntries(entries).violations).toEqual(entries.slice(0, 2));
  });

  test.each([
    ".env",
    "src/.env.production",
    ".git/config",
    ".github/workflows/deploy.yml",
    "src/secret.pem",
    "nested/master.key",
    "nested/id_rsa",
    "nested/service-role.json",
    "supabase/.temp/project-ref",
    "nested/supabase/.temp/project-ref",
  ])("keeps existing secret and internal-path exclusions for %s", (entry) => {
    expect(inspectArtifactEntries([entry]).passed).toBe(false);
  });
});
