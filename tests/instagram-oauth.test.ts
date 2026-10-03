import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { integrationById, credentialGroupOf } from "../src/lib/integrations/registry";
import {
  buildAuthorizationUrl,
  exchangeCode,
  exchangeInstagramLongLivedToken,
  OAUTH_PROVIDERS,
  refreshAccessToken,
} from "../src/lib/integrations/providers.server";

const savedInstagramEnv = {
  appId: process.env["INSTAGRAM_APP_ID"],
  appSecret: process.env["INSTAGRAM_APP_SECRET"],
  facebookAppId: process.env["FACEBOOK_APP_ID"],
  facebookAppSecret: process.env["FACEBOOK_APP_SECRET"],
};
const realFetch = globalThis.fetch;

beforeEach(() => {
  delete process.env["INSTAGRAM_APP_ID"];
  delete process.env["INSTAGRAM_APP_SECRET"];
  delete process.env["FACEBOOK_APP_ID"];
  delete process.env["FACEBOOK_APP_SECRET"];
});

afterEach(() => {
  for (const [key, value] of [
    ["INSTAGRAM_APP_ID", savedInstagramEnv.appId],
    ["INSTAGRAM_APP_SECRET", savedInstagramEnv.appSecret],
    ["FACEBOOK_APP_ID", savedInstagramEnv.facebookAppId],
    ["FACEBOOK_APP_SECRET", savedInstagramEnv.facebookAppSecret],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = realFetch;
});

const instagramCredentials = {
  INSTAGRAM_APP_ID: "instagram-app-id",
  INSTAGRAM_APP_SECRET: "instagram-app-secret",
};
const requiredInstagramPermissions = [
  "instagram_business_basic",
  "instagram_business_manage_comments",
  "instagram_business_manage_messages",
];

describe("Instagram Login OAuth uses its own app and permissions", () => {
  test("separates the Instagram credential vault from Facebook", () => {
    expect(credentialGroupOf("instagram")).toBe("instagram");
    expect(credentialGroupOf("instagram")).not.toBe(credentialGroupOf("facebook"));
    expect(integrationById("instagram")?.requiredSecrets).toEqual([
      "INSTAGRAM_APP_ID",
      "INSTAGRAM_APP_SECRET",
    ]);
    expect(integrationById("instagram")?.scopes).toEqual(requiredInstagramPermissions);
  });

  test("builds Instagram Business Login URL with encoded modern scopes and callback", () => {
    const authorizationUrl = buildAuthorizationUrl(
      "instagram",
      "https://seovale.com/api/public/integrations/callback",
      "state-value",
      null,
      instagramCredentials,
    );
    const url = new URL(authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("instagram-app-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://seovale.com/api/public/integrations/callback",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("scope")?.split(",")).toEqual(requiredInstagramPermissions);
    expect(url.searchParams.get("scope")).not.toContain("instagram_basic");
    expect(url.searchParams.get("scope")).not.toContain("pages_show_list");
    expect(url.searchParams.has("client_secret")).toBe(false);
  });

  test("Facebook still builds authorization with the Facebook app and endpoint", () => {
    const authorizationUrl = buildAuthorizationUrl(
      "facebook",
      "https://seovale.com/api/public/integrations/callback",
      "facebook-state",
      null,
      { FACEBOOK_APP_ID: "facebook-app-id" },
    );
    const url = new URL(authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v21.0/dialog/oauth");
    expect(url.searchParams.get("client_id")).toBe("facebook-app-id");
    expect(url.searchParams.get("scope")).toContain("pages_show_list");
    expect(url.searchParams.get("scope")).not.toContain("instagram_business_basic");
  });
});

describe("Instagram token lifecycle", () => {
  test("exchanges code through Instagram's form endpoint and parses granted permissions", async () => {
    let sentUrl = "";
    let sentBody = new URLSearchParams();
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      sentUrl = String(input);
      sentBody = new URLSearchParams(String(init?.body));
      expect(init?.method).toBe("POST");
      return new Response(
        JSON.stringify({
          data: [
            {
              access_token: "short-token",
              user_id: "ig-user-id",
              permissions: requiredInstagramPermissions.join(","),
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await exchangeCode(
      "instagram",
      "one-time-code",
      null,
      "https://seovale.com/api/public/integrations/callback",
      instagramCredentials,
    );
    expect(sentUrl).toBe("https://api.instagram.com/oauth/access_token");
    expect(sentBody.get("client_id")).toBe("instagram-app-id");
    expect(sentBody.get("client_secret")).toBe("instagram-app-secret");
    expect(sentBody.get("grant_type")).toBe("authorization_code");
    expect(sentBody.get("redirect_uri")).toBe(
      "https://seovale.com/api/public/integrations/callback",
    );
    expect(sentBody.get("code")).toBe("one-time-code");
    expect(result.accessToken).toBe("short-token");
    expect(result.accountId).toBe("ig-user-id");
    expect(result.scopes).toEqual(requiredInstagramPermissions);
  });

  test("exchanges short-lived token for long-lived token only through the server adapter", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ access_token: "long-token", expires_in: 5_183_000 }), {
        status: 200,
      });
    }) as typeof fetch;

    const result = await exchangeInstagramLongLivedToken("short-token", instagramCredentials);
    const url = new URL(requestedUrl);
    expect(url.origin + url.pathname).toBe("https://graph.instagram.com/access_token");
    expect(url.searchParams.get("grant_type")).toBe("ig_exchange_token");
    expect(url.searchParams.get("client_secret")).toBe("instagram-app-secret");
    expect(url.searchParams.get("access_token")).toBe("short-token");
    expect(result).toEqual({ accessToken: "long-token", expiresIn: 5_183_000 });
  });

  test("does not assume an expiration when Meta omits it for long-lived tokens", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ access_token: "long-token" }), {
        status: 200,
      })) as typeof fetch;

    await expect(
      exchangeInstagramLongLivedToken("short-token", instagramCredentials),
    ).rejects.toThrow("no valid expiration");
  });

  test("refreshes Instagram long-lived tokens through Instagram's refresh endpoint", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({ access_token: "refreshed-token", expires_in: 5_184_000 }),
        {
          status: 200,
        },
      );
    }) as typeof fetch;

    const result = await refreshAccessToken("instagram", "old-long-token");
    const url = new URL(requestedUrl);
    expect(url.origin + url.pathname).toBe("https://graph.instagram.com/refresh_access_token");
    expect(url.searchParams.get("grant_type")).toBe("ig_refresh_token");
    expect(url.searchParams.get("access_token")).toBe("old-long-token");
    expect(result.accessToken).toBe("refreshed-token");
    expect(result.expiresIn).toBe(5_184_000);
  });

  test("verifies the account with a live Instagram API request and bearer header", async () => {
    const requests: { url: string; auth: string }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, auth: new Headers(init?.headers).get("authorization") ?? "" });
      if (url.includes("/me?fields=")) {
        return new Response(
          JSON.stringify({ data: [{ user_id: "ig-user-id", username: "theseovale" }] }),
          { status: 200 },
        );
      }
      if (url.includes("/media?")) {
        return new Response(JSON.stringify({ data: [{ id: "media-id" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;

    const result = await OAUTH_PROVIDERS["instagram"]!.test("private-access-token");
    expect(requests.map((request) => request.url)).toEqual([
      "https://graph.instagram.com/v25.0/me?fields=user_id,username",
      "https://graph.instagram.com/v25.0/ig-user-id/media?fields=id&limit=1",
      "https://graph.instagram.com/v25.0/media-id/comments?fields=id&limit=1",
      "https://graph.instagram.com/v25.0/me/conversations?platform=instagram&limit=1",
    ]);
    expect(requests.every((request) => request.auth === "Bearer private-access-token")).toBe(true);
    expect(requests.every((request) => !request.url.includes("private-access-token"))).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      code: "CONNECTED",
      message: "Instagram account, comments and messaging APIs verified.",
      label: "theseovale",
      accountRef: "ig-user-id",
    });
  });

  test("tests basic account and messaging APIs, but reports when no media exists for a comments test", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/me?fields=")) {
        return new Response(JSON.stringify({ user_id: "ig-user-id", username: "theseovale" }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;

    const result = await OAUTH_PROVIDERS["instagram"]!.test("private-access-token");
    expect(requests).toHaveLength(3);
    expect(requests.some((url) => url.includes("/comments"))).toBe(false);
    expect(requests.some((url) => url.includes("/conversations"))).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.message).toContain(
      "Comment access could not be tested because the account has no media.",
    );
  });

  test("reports insufficient comments permission without exposing provider error details", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/me?fields=")) {
        return new Response(JSON.stringify({ user_id: "ig-user-id", username: "theseovale" }), {
          status: 200,
        });
      }
      if (url.includes("/media?")) {
        return new Response(JSON.stringify({ data: [{ id: "media-id" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: "private-access-token" } }), {
        status: 403,
      });
    }) as typeof fetch;

    const result = await OAUTH_PROVIDERS["instagram"]!.test("private-access-token");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("INSUFFICIENT_SCOPE");
    expect(result.message).toContain("instagram_business_manage_comments");
    expect(result.message).not.toContain("private-access-token");
  });

  test("reports insufficient messaging permission without exposing provider error details", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/me?fields=")) {
        return new Response(JSON.stringify({ user_id: "ig-user-id", username: "theseovale" }), {
          status: 200,
        });
      }
      if (url.includes("/media?")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: "private-access-token" } }), {
        status: 403,
      });
    }) as typeof fetch;

    const result = await OAUTH_PROVIDERS["instagram"]!.test("private-access-token");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("INSUFFICIENT_SCOPE");
    expect(result.message).toContain("instagram_business_manage_messages");
    expect(result.message).not.toContain("private-access-token");
  });

  test("does not expose raw Meta errors or token material from the profile check", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "token=private-access-token" } }), {
        status: 403,
      })) as typeof fetch;

    const result = await OAUTH_PROVIDERS["instagram"]!.test("private-access-token");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("INSUFFICIENT_SCOPE");
    expect(result.message).not.toContain("private-access-token");
    expect(result.message).not.toContain("token=");
  });
});

describe("Facebook Page API regression", () => {
  test("Facebook Page discovery stays on its existing Graph API integration", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ data: [{ id: "page-id", name: "SEO Vale" }] }), {
        status: 200,
      });
    }) as typeof fetch;

    const result = await OAUTH_PROVIDERS["facebook"]!.test("page-token");
    expect(requestedUrl).toBe(
      "https://graph.facebook.com/v21.0/me/accounts?fields=id,name&access_token=page-token",
    );
    expect(result).toMatchObject({ ok: true, label: "SEO Vale", accountRef: "page-id" });
  });

  test("Facebook authorization-code exchange remains on its existing token endpoint", async () => {
    let requestedUrl = "";
    let body = new URLSearchParams();
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      body = new URLSearchParams(String(init?.body));
      return new Response(JSON.stringify({ access_token: "facebook-token", expires_in: 3600 }), {
        status: 200,
      });
    }) as typeof fetch;

    const result = await exchangeCode(
      "facebook",
      "facebook-code",
      null,
      "https://seovale.com/api/public/integrations/callback",
      { FACEBOOK_APP_ID: "facebook-app-id", FACEBOOK_APP_SECRET: "facebook-app-secret" },
    );
    expect(requestedUrl).toBe("https://graph.facebook.com/v21.0/oauth/access_token");
    expect(body.get("client_id")).toBe("facebook-app-id");
    expect(body.get("client_secret")).toBe("facebook-app-secret");
    expect(body.get("code")).toBe("facebook-code");
    expect(result.accessToken).toBe("facebook-token");
  });
});
