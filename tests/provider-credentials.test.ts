/**
 * UI-managed provider credentials: registry schema, vault-first resolution with
 * environment fallback, removal, per-workspace AI keys and webhook secrets.
 *
 * Unit tests only: the vault runs against an in-memory table stub and provider
 * HTTP calls against a stubbed fetch. Nothing is written to any database and no
 * provider is contacted. Every environment variable touched is restored.
 *
 * Run with: bun test tests/
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { INTEGRATIONS, credentialGroupOf, integrationById } from "../src/lib/integrations/registry";
import { envValue, missingRequiredSecrets, OAUTH_PROVIDERS, providerConfigured, testApiKeyProvider, testTwitterAppOnly } from "../src/lib/integrations/providers.server";
import { deleteProviderCredentials, loadProviderCredentials, saveProviderCredentials } from "../src/lib/integrations/credentials.server";
import { resolveAiKeys } from "../src/lib/ai-keys.server";
import { matchWebhookSecret, secretCoversWorkspace } from "../src/lib/integrations/webhook-secrets.server";

const TOUCHED_ENV = [
  "INTEGRATION_TOKEN_ENCRYPTION_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "LOVABLE_API_KEY",
  "SEMRUSH_API_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
  "TWITTER_BEARER_TOKEN",
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "FACEBOOK_APP_SECRET",
  "INSTAGRAM_APP_ID",
  "INSTAGRAM_APP_SECRET",
];
let savedEnv: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

beforeEach(() => {
  savedEnv = Object.fromEntries(TOUCHED_ENV.map((name) => [name, process.env[name]]));
  for (const name of TOUCHED_ENV) delete process.env[name];
  process.env["INTEGRATION_TOKEN_ENCRYPTION_KEY"] = "unit-test-only-encryption-key";
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  globalThis.fetch = realFetch;
});

/** Minimal in-memory stand-in for the integration_provider_credentials table. */
function memoryVault() {
  const rows: Record<string, any>[] = [];
  const query = (filters: [string, unknown][] = []) => {
    const matching = () => rows.filter((row) => filters.every(([k, v]) => row[k] === v));
    const builder: any = {
      eq: (k: string, v: unknown) => query([...filters, [k, v]]),
      then: (resolve: (value: unknown) => unknown) => resolve({ data: matching(), error: null }),
    };
    return builder;
  };
  const admin = {
    rows,
    from: (_table: string) => ({
      select: () => query(),
      upsert: (row: Record<string, any>) => {
        const index = rows.findIndex((r) => r.workspace_id === row.workspace_id && r.provider === row.provider && r.field_key === row.field_key);
        if (index >= 0) rows[index] = row;
        else rows.push(row);
        return Promise.resolve({ error: null });
      },
      delete: () => {
        const filters: [string, unknown][] = [];
        const builder: any = {
          eq: (k: string, v: unknown) => {
            filters.push([k, v]);
            return builder;
          },
          then: (resolve: (value: unknown) => unknown) => {
            for (let i = rows.length - 1; i >= 0; i -= 1) if (filters.every(([k, v]) => rows[i]![k] === v)) rows.splice(i, 1);
            return resolve({ error: null });
          },
        };
        return builder;
      },
    }),
  };
  return admin;
}

describe("registry — every requested credential field is UI-configurable", () => {
  const expected: Record<string, string[]> = {
    ahrefs: ["AHREFS_API_TOKEN"],
    anthropic: ["ANTHROPIC_API_KEY"],
    dataforseo: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"],
    facebook: ["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET", "META_WEBHOOK_VERIFY_TOKEN"],
    instagram: ["INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET"],
    meta_business: ["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET"],
    moz: ["MOZ_ACCESS_ID", "MOZ_SECRET_KEY"],
    openai: ["OPENAI_API_KEY"],
    pinterest: ["PINTEREST_CLIENT_ID", "PINTEREST_CLIENT_SECRET"],
    razorpay: ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"],
    reddit: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"],
    resend_email: ["RESEND_API_KEY", "RESEND_FROM_DOMAIN"],
    semrush: ["SEMRUSH_API_KEY"],
    serpapi: ["SERPAPI_API_KEY"],
    stripe: ["STRIPE_PUBLISHABLE_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
    tripadvisor: ["TRIPADVISOR_API_KEY"],
    trustpilot: ["TRUSTPILOT_API_KEY", "TRUSTPILOT_API_SECRET", "TRUSTPILOT_WEBHOOK_SECRET"],
    twilio_sms: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET", "TWILIO_PHONE_NUMBER"],
    twitter: ["TWITTER_CLIENT_ID", "TWITTER_CLIENT_SECRET", "TWITTER_BEARER_TOKEN", "TWITTER_CONSUMER_KEY", "TWITTER_CONSUMER_SECRET"],
    uptime_monitor: ["UPTIMEROBOT_API_KEY"],
    url_reputation: ["SAFE_BROWSING_API_KEY"],
    whatsapp: ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_BUSINESS_ACCOUNT_ID", "WHATSAPP_WEBHOOK_VERIFY_TOKEN"],
    yelp: ["YELP_FUSION_API_KEY"],
    pagespeed: ["PAGESPEED_API_KEY"],
    google_ads: ["GOOGLE_ADS_DEVELOPER_TOKEN"],
  };

  for (const [provider, keys] of Object.entries(expected)) {
    test(`${provider} exposes ${keys.join(", ")}`, () => {
      const fields = (integrationById(provider)?.credentialFields ?? []).map((f) => f.key);
      for (const key of keys) expect(fields).toContain(key);
    });
  }

  test("secret-bearing fields are masked (secret: true)", () => {
    const secretKeys = [
      "FACEBOOK_APP_SECRET",
      "INSTAGRAM_APP_SECRET",
      "RAZORPAY_WEBHOOK_SECRET",
      "STRIPE_SECRET_KEY",
      "TWILIO_API_KEY_SECRET",
      "TWITTER_BEARER_TOKEN",
      "TWITTER_CONSUMER_SECRET",
      "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
      "TRUSTPILOT_API_SECRET",
      "OPENAI_API_KEY",
    ];
    const all = INTEGRATIONS.flatMap((d) => d.credentialFields ?? []);
    for (const key of secretKeys) expect(all.filter((f) => f.key === key).every((f) => f.secret)).toBe(true);
  });

  test("partner-only providers stay manual with no invented adapter", () => {
    for (const id of ["glassdoor", "indeed"]) {
      expect(integrationById(id)?.kind).toBe("manual");
      expect(integrationById(id)?.credentialFields ?? []).toEqual([]);
    }
  });

  test("Meta Business shares the Meta app's vault group", () => {
    expect(credentialGroupOf("meta_business")).toBe(credentialGroupOf("facebook"));
  });
});

describe("vault first, environment fallback", () => {
  test("a vault value wins over the environment; env is used only when the vault has none", () => {
    process.env["SEMRUSH_API_KEY"] = "env-key";
    expect(envValue(["SEMRUSH_API_KEY"], { SEMRUSH_API_KEY: "vault-key" })).toBe("vault-key");
    expect(envValue(["SEMRUSH_API_KEY"], {})).toBe("env-key");
    delete process.env["SEMRUSH_API_KEY"];
    expect(envValue(["SEMRUSH_API_KEY"], {})).toBeUndefined();
  });

  test("Twilio counts as configured with API-key auth instead of the auth token", () => {
    expect(missingRequiredSecrets("twilio_sms", { TWILIO_ACCOUNT_SID: "AC1" })).toEqual(["TWILIO_AUTH_TOKEN"]);
    expect(missingRequiredSecrets("twilio_sms", { TWILIO_ACCOUNT_SID: "AC1", TWILIO_API_KEY_SID: "SK1", TWILIO_API_KEY_SECRET: "s" })).toEqual([]);
    expect(providerConfigured("twilio_sms", { TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t" })).toBe(true);
  });
});

describe("removing a credential stops its use", () => {
  test("after delete, the vault returns nothing and no stale value is used", async () => {
    const admin = memoryVault();
    await saveProviderCredentials(admin, "ws-1", "semrush", "user-1", { SEMRUSH_API_KEY: "vault-key-1234" });
    const before = await loadProviderCredentials(admin, "ws-1", "semrush");
    expect(before["SEMRUSH_API_KEY"]).toBe("vault-key-1234");
    expect(admin.rows[0]!["value_ciphertext"]).not.toContain("vault-key-1234");
    expect(admin.rows[0]!["masked_hint"]).toBe("••••1234");

    await deleteProviderCredentials(admin, "ws-1", "semrush");
    const after = await loadProviderCredentials(admin, "ws-1", "semrush");
    expect(after).toEqual({});
    expect(envValue(["SEMRUSH_API_KEY"], after)).toBeUndefined();
    expect(providerConfigured("semrush", after)).toBe(false);

    // Only a real environment value can take over.
    process.env["SEMRUSH_API_KEY"] = "env-key";
    expect(envValue(["SEMRUSH_API_KEY"], after)).toBe("env-key");
  });

  test("a live test after removal reports NOT_CONFIGURED without calling the provider", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const result = await testApiKeyProvider("semrush", null, {});
    expect(result.code).toBe("NOT_CONFIGURED");
    expect(called).toBe(false);
  });

  test("vault rows are workspace-scoped", async () => {
    const admin = memoryVault();
    await saveProviderCredentials(admin, "ws-1", "openai", "u", { OPENAI_API_KEY: "sk-ws1" });
    expect(await loadProviderCredentials(admin, "ws-2", "openai")).toEqual({});
  });
});

describe("AI gateway — per-workspace keys", () => {
  const loader = (bags: Record<string, Record<string, string>>) => async (group: string) => bags[group] ?? {};

  test("the workspace's vault key is picked over the environment", async () => {
    process.env["OPENAI_API_KEY"] = "sk-env";
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-env";
    const keys = await resolveAiKeys("ws-1", loader({ openai: { OPENAI_API_KEY: "sk-vault" }, anthropic: { ANTHROPIC_API_KEY: "sk-ant-vault" } }));
    expect(keys.openai).toBe("sk-vault");
    expect(keys.anthropic).toBe("sk-ant-vault");
  });

  test("falls back to the environment when the workspace has no key", async () => {
    process.env["OPENAI_API_KEY"] = "sk-env";
    const keys = await resolveAiKeys("ws-1", loader({}));
    expect(keys.openai).toBe("sk-env");
    expect(keys.anthropic).toBeNull();
  });

  test("a removed vault key with no env key leaves the provider unconfigured", async () => {
    const keys = await resolveAiKeys("ws-1", loader({ openai: {} }));
    expect(keys.openai).toBeNull();
  });

  test("an unreadable vault falls back to the environment instead of failing", async () => {
    process.env["OPENAI_API_KEY"] = "sk-env";
    const keys = await resolveAiKeys("ws-1", async () => {
      throw new Error("vault down");
    });
    expect(keys.openai).toBe("sk-env");
  });

  test("Lovable AI stays environment-only", async () => {
    process.env["LOVABLE_API_KEY"] = "lov-env";
    expect((await resolveAiKeys("ws-1", loader({}))).lovable).toBe("lov-env");
  });
});

describe("live tests use the saved credentials and report truthfully", () => {
  test("X app-only test sends the saved bearer token; 402 is reported, never CONNECTED", async () => {
    let sentAuth = "";
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sentAuth = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({ title: "CreditsDepleted", detail: "Your enrolled account does not have any credits to fulfill this request." }), { status: 402 });
    }) as unknown as typeof fetch;
    const result = await testTwitterAppOnly({ TWITTER_BEARER_TOKEN: "vault-bearer" });
    expect(sentAuth).toBe("Bearer vault-bearer");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("PROVIDER_ERROR");
    expect(result.message).toContain("does not have any credits");
  });

  test("X app-only test without a bearer token is NOT_CONFIGURED", async () => {
    expect((await testTwitterAppOnly({})).code).toBe("NOT_CONFIGURED");
  });

  test("Google Ads test reads the developer token from the vault", async () => {
    let devToken = "";
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      devToken = new Headers(init?.headers).get("developer-token") ?? "";
      return new Response(JSON.stringify({ resourceNames: ["customers/1"] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await OAUTH_PROVIDERS["google_ads"]!.test("access", { GOOGLE_ADS_DEVELOPER_TOKEN: "vault-dev-token" });
    expect(devToken).toBe("vault-dev-token");
    expect(result.code).toBe("CONNECTED");
  });

  test("a 401 from the provider is AUTHENTICATION_FAILED", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401 })) as unknown as typeof fetch;
    const result = await testApiKeyProvider("openai", null, { OPENAI_API_KEY: "sk-bad" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("AUTHENTICATION_FAILED");
  });
});

describe("webhook secrets — vault with env fallback, never cross-workspace", () => {
  const reader = (rows: Record<string, { workspaceId: string; secret: string }[]>) => async (group: string, field: string) => rows[`${group}/${field}`] ?? [];

  test("the env secret is checked first and needs no vault read", async () => {
    process.env["FACEBOOK_APP_SECRET"] = "env-secret";
    let read = false;
    const match = await matchWebhookSecret(["FACEBOOK_APP_SECRET"], [{ group: "meta", field: "FACEBOOK_APP_SECRET" }], (s) => s === "env-secret", async () => {
      read = true;
      return [];
    });
    expect(match.env).toBe(true);
    expect(read).toBe(false);
  });

  test("a workspace's vault secret authenticates only that workspace's events", async () => {
    const match = await matchWebhookSecret(
      ["FACEBOOK_APP_SECRET"],
      [{ group: "meta", field: "FACEBOOK_APP_SECRET" }],
      (s) => s === "secret-a",
      reader({ "meta/FACEBOOK_APP_SECRET": [{ workspaceId: "ws-a", secret: "secret-a" }, { workspaceId: "ws-b", secret: "secret-b" }] }),
    );
    expect(match.configured).toBe(true);
    expect(match.workspaceIds).toEqual(["ws-a"]);
    expect(secretCoversWorkspace(match, "ws-a")).toBe(true);
    expect(secretCoversWorkspace(match, "ws-b")).toBe(false);
  });

  test("with no secret anywhere the webhook is reported unconfigured", async () => {
    const match = await matchWebhookSecret(["FACEBOOK_APP_SECRET"], [{ group: "meta", field: "FACEBOOK_APP_SECRET" }], () => true, reader({}));
    expect(match).toEqual({ configured: false, env: false, workspaceIds: [] });
  });
});
