import { afterAll, beforeAll, expect, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import { rateLimit } from "../src/lib/license/authority.server";

const previousPepper = process.env.LICENSE_TOKEN_PEPPER;
beforeAll(() => {
  process.env.LICENSE_TOKEN_PEPPER = "rate-limit-test-fixture";
});
afterAll(() => {
  if (previousPepper === undefined) delete process.env.LICENSE_TOKEN_PEPPER;
  else process.env.LICENSE_TOKEN_PEPPER = previousPepper;
});

function clientFor(result: unknown, status = 200) {
  return createClient("https://fixture.supabase.co", "fixture-key", {
    auth: { persistSession: false },
    global: {
      fetch: async () =>
        new Response(JSON.stringify(result), {
          status,
          headers: { "content-type": "application/json" },
        }),
    },
  });
}

test("rate limit allows a valid counter and distinguishes an exceeded budget", async () => {
  expect(await rateLimit(clientFor(1), "google_places_scan", "workspace", 30, 3600)).toMatchObject({
    allowed: true,
    count: 1,
  });
  const denied = await rateLimit(clientFor(31), "google_places_scan", "workspace", 30, 3600);
  expect(denied).toMatchObject({ allowed: false, count: 31 });
  expect(denied.error).toBeUndefined();
});

test("rate limit fails closed and exposes the database error instead of claiming exhaustion", async () => {
  const result = await rateLimit(
    clientFor({ code: "PGRST202", message: "consume_rate_limit was not found" }, 404),
    "google_places_scan",
    "workspace",
    30,
    3600,
  );
  expect(result.allowed).toBe(false);
  expect(result.error).toBe("consume_rate_limit was not found");
});

test("rate limit fails closed with an explicit invalid-counter error", async () => {
  expect(
    await rateLimit(clientFor(null), "google_places_scan", "workspace", 30, 3600),
  ).toMatchObject({
    allowed: false,
    error: "Rate limit storage returned an invalid counter.",
  });
});
