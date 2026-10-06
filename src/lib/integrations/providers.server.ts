// Real provider wiring: authorization URLs, token exchange/refresh and live
// connection tests. Every call below hits the provider's documented API — no
// simulated responses and no success status without a real HTTP 2xx.
import { integrationById, type TestOutcomeCode } from "./registry";

export interface TestResult {
  ok: boolean;
  status: number;
  message: string;
  label?: string | null;
  accountRef?: string | null;
  rateLimited?: boolean;
  code?: TestOutcomeCode;
}

export interface OAuthProviderConfig {
  authUrl: string;
  tokenUrl: string;
  clientIdEnv: string[];
  clientSecretEnv: string[];
  usePkce: boolean;
  tokenAuth: "basic" | "body";
  extraAuthParams?: Record<string, string>;
  headers?: Record<string, string>;
  test: (accessToken: string) => Promise<TestResult>;
}

const USER_AGENT = "Seovale/1.0 (reputation monitoring)";

export type CredentialBag = Record<string, string>;

/** Vault credentials win over the server environment fallback. */
export function envValue(names: string[], creds: CredentialBag = {}) {
  for (const name of names) {
    const value = creds[name] ?? process.env[name];
    if (value) return value;
  }
  return undefined;
}

/** Standard outcome code from an HTTP status — never invents success. */
export function outcomeFor(ok: boolean, status: number, message: string): TestOutcomeCode {
  if (ok) return "CONNECTED";
  if (status === 0) {
    const lower = message.toLowerCase();
    return lower.includes("not configured") || lower.includes("missing") || lower.includes("required") || lower.includes("add your")
      ? "NOT_CONFIGURED"
      : "PROVIDER_ERROR";
  }
  if (status === 401) return "AUTHENTICATION_FAILED";
  if (status === 403) {
    if (/scope|insufficient permission/i.test(message)) return "INSUFFICIENT_SCOPE";
    // Google returns 403 when the API itself is disabled or needs allow-listing for the project;
    // that is a provider-side setup state, not a bad credential.
    if (/has not been used in project|is disabled|blocked|not enabled|enable it by visiting|accessNotConfigured/i.test(message))
      return "APPROVAL_REQUIRED";
    return "INVALID_CREDENTIALS";
  }
  if (status === 429) return "RATE_LIMITED";
  return "PROVIDER_ERROR";
}

export const notConfigured = (message: string): TestResult => ({
  ok: false,
  status: 0,
  message,
  code: "NOT_CONFIGURED",
});

async function readJson(response: Response) {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    return { raw: text.slice(0, 200) } as Record<string, any>;
  }
}

function failure(response: Response, payload: Record<string, any>): TestResult {
  const message =
    payload?.["error"]?.["message"] ??
    (typeof payload?.["error"] === "string" ? payload["error"] : undefined) ??
    payload?.["message"] ??
    payload?.["detail"] ??
    `Provider returned HTTP ${response.status}`;
  const text = String(message);
  return {
    ok: false,
    status: response.status,
    message: text.slice(0, 300),
    rateLimited: response.status === 429,
    code: outcomeFor(false, response.status, text),
  };
}

async function googleTest(url: string, accessToken: string, pick: (p: Record<string, any>) => { label?: string | null; ref?: string | null }) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const payload = await readJson(response);
  if (!response.ok) return failure(response, payload);
  const picked = pick(payload);
  return { ok: true, status: response.status, message: "Live API call succeeded.", label: picked.label ?? null, accountRef: picked.ref ?? null };
}

export const OAUTH_PROVIDERS: Record<string, OAuthProviderConfig> = {
  google_gmail: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientIdEnv: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_BUSINESS_CLIENT_ID"],
    clientSecretEnv: ["GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_BUSINESS_CLIENT_SECRET"],
    usePkce: true,
    tokenAuth: "body",
    extraAuthParams: { access_type: "offline", prompt: "consent select_account", include_granted_scopes: "true" },
    test: (token) =>
      googleTest("https://gmail.googleapis.com/gmail/v1/users/me/profile", token, (p) => ({
        label: p["emailAddress"],
        ref: p["emailAddress"],
      })),
  },
  youtube: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientIdEnv: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_BUSINESS_CLIENT_ID"],
    clientSecretEnv: ["GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_BUSINESS_CLIENT_SECRET"],
    usePkce: true,
    tokenAuth: "body",
    extraAuthParams: { access_type: "offline", prompt: "consent select_account", include_granted_scopes: "true" },
    test: (token) =>
      googleTest("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", token, (p) => {
        const item = (p["items"] ?? [])[0];
        return { label: item?.["snippet"]?.["title"] ?? null, ref: item?.["id"] ?? null };
      }),
  },
  youtube_analytics: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientIdEnv: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_BUSINESS_CLIENT_ID"],
    clientSecretEnv: ["GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_BUSINESS_CLIENT_SECRET"],
    usePkce: true,
    tokenAuth: "body",
    extraAuthParams: { access_type: "offline", prompt: "consent select_account", include_granted_scopes: "true" },
    test: (token) =>
      googleTest(
        "https://youtubeanalytics.googleapis.com/v2/reports?ids=channel%3D%3DMINE&startDate=2024-01-01&endDate=2024-01-07&metrics=views",
        token,
        () => ({ label: "YouTube Analytics", ref: null }),
      ),
  },
  facebook: {
    authUrl: "https://www.facebook.com/v21.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v21.0/oauth/access_token",
    clientIdEnv: ["FACEBOOK_APP_ID"],
    clientSecretEnv: ["FACEBOOK_APP_SECRET"],
    usePkce: false,
    tokenAuth: "body",
    test: async (token) => {
      const response = await fetch(`https://graph.facebook.com/v21.0/me/accounts?fields=id,name&access_token=${encodeURIComponent(token)}`);
      const payload = await readJson(response);
      if (!response.ok) return failure(response, payload);
      const page = (payload["data"] ?? [])[0];
      if (!page) {
        return { ok: false, status: response.status, message: "No Facebook Page is available to this account. Grant Page access in the Meta Business portfolio." };
      }
      return { ok: true, status: response.status, message: "Live Graph API call succeeded.", label: page["name"], accountRef: page["id"] };
    },
  },
  instagram: {
    authUrl: "https://www.facebook.com/v21.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v21.0/oauth/access_token",
    clientIdEnv: ["FACEBOOK_APP_ID"],
    clientSecretEnv: ["FACEBOOK_APP_SECRET"],
    usePkce: false,
    tokenAuth: "body",
    test: async (token) => {
      const response = await fetch(
        `https://graph.facebook.com/v21.0/me/accounts?fields=instagram_business_account{id,username}&access_token=${encodeURIComponent(token)}`,
      );
      const payload = await readJson(response);
      if (!response.ok) return failure(response, payload);
      const linked = (payload["data"] ?? []).map((row: Record<string, any>) => row["instagram_business_account"]).find(Boolean);
      if (!linked) {
        return { ok: false, status: response.status, message: "No Instagram professional account is linked to the authorized Facebook Page." };
      }
      return { ok: true, status: response.status, message: "Live Graph API call succeeded.", label: linked["username"] ?? null, accountRef: linked["id"] };
    },
  },
  reddit: {
    authUrl: "https://www.reddit.com/api/v1/authorize",
    tokenUrl: "https://www.reddit.com/api/v1/access_token",
    clientIdEnv: ["REDDIT_CLIENT_ID"],
    clientSecretEnv: ["REDDIT_CLIENT_SECRET"],
    usePkce: false,
    tokenAuth: "basic",
    extraAuthParams: { duration: "permanent" },
    headers: { "User-Agent": USER_AGENT },
    test: async (token) => {
      const response = await fetch("https://oauth.reddit.com/api/v1/me", {
        headers: { Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT },
      });
      const payload = await readJson(response);
      if (!response.ok) return failure(response, payload);
      return { ok: true, status: response.status, message: "Live Reddit API call succeeded.", label: payload["name"] ? `u/${payload["name"]}` : null, accountRef: payload["id"] ?? null };
    },
  },
  twitter: {
    authUrl: "https://x.com/i/oauth2/authorize",
    tokenUrl: "https://api.x.com/2/oauth2/token",
    clientIdEnv: ["TWITTER_CLIENT_ID"],
    clientSecretEnv: ["TWITTER_CLIENT_SECRET"],
    usePkce: true,
    tokenAuth: "basic",
    test: async (token) => {
      const response = await fetch("https://api.x.com/2/users/me", { headers: { Authorization: `Bearer ${token}` } });
      const payload = await readJson(response);
      if (!response.ok) return failure(response, payload);
      const user = payload["data"] ?? {};
      return { ok: true, status: response.status, message: "Live X API call succeeded.", label: user["username"] ? `@${user["username"]}` : null, accountRef: user["id"] ?? null, code: "CONNECTED" };
    },
  },
  pinterest: {
    authUrl: "https://www.pinterest.com/oauth/",
    tokenUrl: "https://api.pinterest.com/v5/oauth/token",
    clientIdEnv: ["PINTEREST_CLIENT_ID"],
    clientSecretEnv: ["PINTEREST_CLIENT_SECRET"],
    usePkce: true,
    tokenAuth: "basic",
    test: async (token) => {
      const response = await fetch("https://api.pinterest.com/v5/user_account", { headers: { Authorization: `Bearer ${token}` } });
      const payload = await readJson(response);
      if (!response.ok) return failure(response, payload);
      return {
        ok: true,
        status: response.status,
        message: "Live Pinterest API call succeeded.",
        label: payload["username"] ? `@${payload["username"]}` : null,
        accountRef: payload["id"] ?? null,
        code: "CONNECTED",
      };
    },
  },
  google_search_console: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientIdEnv: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_BUSINESS_CLIENT_ID"],
    clientSecretEnv: ["GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_BUSINESS_CLIENT_SECRET"],
    usePkce: true,
    tokenAuth: "body",
    extraAuthParams: { access_type: "offline", prompt: "consent select_account", include_granted_scopes: "true" },
    test: (token) =>
      googleTest("https://www.googleapis.com/webmasters/v3/sites", token, (p) => {
        const site = (p["siteEntry"] ?? [])[0];
        return { label: site?.["siteUrl"] ?? null, ref: site?.["siteUrl"] ?? null };
      }),
  },
  google_analytics: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientIdEnv: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_BUSINESS_CLIENT_ID"],
    clientSecretEnv: ["GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_BUSINESS_CLIENT_SECRET"],
    usePkce: true,
    tokenAuth: "body",
    extraAuthParams: { access_type: "offline", prompt: "consent select_account", include_granted_scopes: "true" },
    test: (token) =>
      googleTest("https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=1", token, (p) => {
        const account = (p["accountSummaries"] ?? [])[0];
        return { label: account?.["displayName"] ?? null, ref: account?.["name"] ?? null };
      }),
  },
  google_ads: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientIdEnv: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_BUSINESS_CLIENT_ID"],
    clientSecretEnv: ["GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_BUSINESS_CLIENT_SECRET"],
    usePkce: true,
    tokenAuth: "body",
    extraAuthParams: { access_type: "offline", prompt: "consent select_account", include_granted_scopes: "true" },
    test: async (token) => {
      const devToken = envValue(["GOOGLE_ADS_DEVELOPER_TOKEN"]);
      if (!devToken) return notConfigured("A Google Ads developer token is required (Google Ads API access approval).");
      const response = await fetch("https://googleads.googleapis.com/v17/customers:listAccessibleCustomers", {
        headers: { Authorization: `Bearer ${token}`, "developer-token": devToken },
      });
      const payload = await readJson(response);
      if (!response.ok) return failure(response, payload);
      const first = (payload["resourceNames"] ?? [])[0];
      return { ok: true, status: response.status, message: "Live Google Ads API call succeeded.", label: first ?? null, accountRef: first ?? null, code: "CONNECTED" };
    },
  },
};

export function providerConfigured(providerId: string, creds: CredentialBag = {}) {
  const oauth = OAUTH_PROVIDERS[providerId];
  if (oauth) return Boolean(envValue(oauth.clientIdEnv, creds) && envValue(oauth.clientSecretEnv, creds));
  const definition = integrationById(providerId);
  if (!definition || definition.requiredSecrets.length === 0) return false;
  return definition.requiredSecrets.every((name) => Boolean(creds[name] ?? process.env[name]));
}

export function buildAuthorizationUrl(providerId: string, redirectUri: string, state: string, challenge: string | null, creds: CredentialBag = {}) {
  const config = OAUTH_PROVIDERS[providerId];
  const definition = integrationById(providerId);
  if (!config || !definition) throw new Error("This integration does not support OAuth.");
  const clientId = envValue(config.clientIdEnv, creds);
  if (!clientId) throw new Error(`${config.clientIdEnv[0]} is not configured.`);
  const url = new URL(config.authUrl);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", definition.scopes.join(" "));
  url.searchParams.set("state", state);
  for (const [k, v] of Object.entries(config.extraAuthParams ?? {})) url.searchParams.set(k, v);
  if (config.usePkce && challenge) {
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

async function tokenRequest(providerId: string, body: URLSearchParams, creds: CredentialBag = {}) {
  const config = OAUTH_PROVIDERS[providerId];
  if (!config) throw new Error("Unknown OAuth integration.");
  const clientId = envValue(config.clientIdEnv, creds);
  const clientSecret = envValue(config.clientSecretEnv, creds);
  if (!clientId || !clientSecret) throw new Error("This integration is missing its application credentials.");
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", ...(config.headers ?? {}) };
  if (config.tokenAuth === "basic") {
    headers["Authorization"] = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
    body.set("client_id", clientId);
  } else {
    body.set("client_id", clientId);
    body.set("client_secret", clientSecret);
  }
  const response = await fetch(config.tokenUrl, { method: "POST", headers, body });
  const payload = await readJson(response);
  if (!response.ok || typeof payload["access_token"] !== "string") {
    const detail = payload["error_description"] ?? payload["error"] ?? `HTTP ${response.status}`;
    throw new Error(`Token request failed: ${String(detail).slice(0, 200)}`);
  }
  return {
    accessToken: payload["access_token"] as string,
    refreshToken: typeof payload["refresh_token"] === "string" ? payload["refresh_token"] : null,
    expiresIn: typeof payload["expires_in"] === "number" ? payload["expires_in"] : 3600,
    scopes: typeof payload["scope"] === "string" ? payload["scope"].split(/[\s,]+/).filter(Boolean) : [],
  };
}

export function exchangeCode(providerId: string, code: string, verifier: string | null, redirectUri: string, creds: CredentialBag = {}) {
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  if (verifier) body.set("code_verifier", verifier);
  return tokenRequest(providerId, body, creds);
}

export function refreshAccessToken(providerId: string, refreshToken: string, creds: CredentialBag = {}) {
  return tokenRequest(providerId, new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }), creds);
}

/** Long-lived Meta user token (60 days) — short-lived tokens expire in ~1 hour. */
export async function exchangeMetaLongLivedToken(shortLivedToken: string, creds: CredentialBag = {}) {
  const clientId = envValue(["FACEBOOK_APP_ID"], creds);
  const clientSecret = envValue(["FACEBOOK_APP_SECRET"], creds);
  if (!clientId || !clientSecret) return null;
  const url = new URL("https://graph.facebook.com/v21.0/oauth/access_token");
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("client_secret", clientSecret);
  url.searchParams.set("fb_exchange_token", shortLivedToken);
  const response = await fetch(url.toString());
  const payload = await readJson(response);
  if (!response.ok || typeof payload["access_token"] !== "string") return null;
  return {
    accessToken: payload["access_token"] as string,
    expiresIn: typeof payload["expires_in"] === "number" ? payload["expires_in"] : 5_184_000,
  };
}

/* ---------- API-key providers ---------- */

export async function testTrustpilot(domain: string | null, creds: CredentialBag = {}): Promise<TestResult> {
  const apiKey = envValue(["TRUSTPILOT_API_KEY"], creds);
  if (!apiKey) return notConfigured("No Trustpilot API key is configured.");
  if (!domain) return { ok: false, status: 0, message: "Add your Trustpilot business domain first.", code: "NOT_CONFIGURED" };
  const url = new URL("https://api.trustpilot.com/v1/business-units/find");
  url.searchParams.set("name", domain);
  url.searchParams.set("apikey", apiKey);
  const response = await fetch(url.toString());
  const payload = await readJson(response);
  if (!response.ok) return failure(response, payload);
  return {
    ok: true,
    status: response.status,
    message: "Trustpilot business unit resolved.",
    label: payload["displayName"] ?? domain,
    accountRef: payload["id"] ?? domain,
  };
}

export async function testTripadvisor(query: string | null, creds: CredentialBag = {}): Promise<TestResult> {
  const apiKey = envValue(["TRIPADVISOR_API_KEY"], creds);
  if (!apiKey) return notConfigured("No Tripadvisor API key is configured.");
  if (!query) return { ok: false, status: 0, message: "Add your Tripadvisor listing name or location ID first.", code: "NOT_CONFIGURED" };
  const numeric = /^\d+$/.test(query);
  const url = numeric
    ? new URL(`https://api.content.tripadvisor.com/api/v1/location/${query}/details`)
    : new URL("https://api.content.tripadvisor.com/api/v1/location/search");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("language", "en");
  if (!numeric) url.searchParams.set("searchQuery", query);
  const response = await fetch(url.toString(), { headers: { accept: "application/json" } });
  const payload = await readJson(response);
  if (!response.ok) return failure(response, payload);
  const match = numeric ? payload : (payload["data"] ?? [])[0];
  if (!match) return { ok: false, status: response.status, message: "Tripadvisor returned no listing for that name." };
  return {
    ok: true,
    status: response.status,
    message: "Tripadvisor listing resolved.",
    label: match["name"] ?? query,
    accountRef: String(match["location_id"] ?? query),
    code: "CONNECTED",
  };
}

/* ---------- API-key providers: one live test per provider ---------- */

async function simpleFetchTest(
  url: string,
  headers: Record<string, string>,
  pick: (payload: Record<string, any>) => { ok: boolean; message?: string; label?: string | null; ref?: string | null },
): Promise<TestResult> {
  const response = await fetch(url, { headers: { accept: "application/json", ...headers } });
  const payload = await readJson(response);
  if (!response.ok) return failure(response, payload);
  const picked = pick(payload);
  if (!picked.ok) {
    return { ok: false, status: response.status, message: picked.message ?? "Provider returned no usable record.", code: "PROVIDER_ERROR" };
  }
  return {
    ok: true,
    status: response.status,
    message: "Live API call succeeded.",
    label: picked.label ?? null,
    accountRef: picked.ref ?? null,
    code: "CONNECTED",
  };
}

/** Routes every api_key provider to its real documented test endpoint. */
export async function testApiKeyProvider(
  providerId: string,
  accountRef: string | null,
  creds: CredentialBag = {},
): Promise<TestResult> {
  switch (providerId) {
    case "trustpilot":
      return testTrustpilot(accountRef, creds);
    case "tripadvisor":
      return testTripadvisor(accountRef, creds);
    case "google_maps": {
      const key = envValue(["GOOGLE_MAPS_API_KEY"], creds);
      if (!key) return notConfigured("No Google Maps API key is configured.");
      return simpleFetchTest(
        `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent("1600 Amphitheatre Parkway, Mountain View, CA")}&key=${encodeURIComponent(key)}`,
        {},
        (p) => ({ ok: p["status"] === "OK", message: p["error_message"] ?? String(p["status"]), label: "Geocoding API", ref: null }),
      );
    }
    case "whatsapp": {
      const token = envValue(["WHATSAPP_ACCESS_TOKEN"], creds);
      const phoneId = envValue(["WHATSAPP_PHONE_NUMBER_ID"], creds);
      if (!token || !phoneId) return notConfigured("WhatsApp access token and phone number ID are required.");
      return simpleFetchTest(
        `https://graph.facebook.com/v21.0/${encodeURIComponent(phoneId)}?access_token=${encodeURIComponent(token)}`,
        {},
        (p) => ({ ok: Boolean(p["id"]), message: "Phone number not found for this token.", label: p["display_phone_number"] ?? null, ref: p["id"] ?? null }),
      );
    }
    case "yelp": {
      const key = envValue(["YELP_FUSION_API_KEY"], creds);
      if (!key) return notConfigured("No Yelp Fusion API key is configured.");
      if (!accountRef) return { ok: false, status: 0, message: "Add your Yelp business alias first.", code: "NOT_CONFIGURED" };
      return simpleFetchTest(
        `https://api.yelp.com/v3/businesses/${encodeURIComponent(accountRef)}`,
        { Authorization: `Bearer ${key}` },
        (p) => ({ ok: Boolean(p["id"]), message: "Yelp returned no business for that alias.", label: p["name"] ?? null, ref: p["id"] ?? null }),
      );
    }
    case "semrush": {
      const key = envValue(["SEMRUSH_API_KEY"], creds);
      if (!key) return notConfigured("No Semrush API key is configured.");
      return simpleFetchTest(
        `https://api.semrush.com/?type=domain_ranks&key=${encodeURIComponent(key)}&export_columns=Dn,Rk&domain=google.com`,
        {},
        (p) => {
          const row = (p["data"] ?? [])[0];
          return { ok: Boolean(row), message: "Semrush returned no data — check the key and remaining units.", label: "Semrush Units API", ref: null };
        },
      );
    }
    case "ahrefs": {
      const token = envValue(["AHREFS_API_TOKEN"], creds);
      if (!token) return notConfigured("No Ahrefs API token is configured.");
      return simpleFetchTest(
        "https://api.ahrefs.com/v3/available-datasets",
        { Authorization: `Bearer ${token}` },
        (p) => ({ ok: Array.isArray(p["datasets"]), message: "Ahrefs rejected the token — API access needs an enabled plan add-on.", label: "Ahrefs API v3", ref: null }),
      );
    }
    case "moz": {
      const id = envValue(["MOZ_ACCESS_ID"], creds);
      const secret = envValue(["MOZ_SECRET_KEY"], creds);
      if (!id || !secret) return notConfigured("Moz access ID and secret key are required.");
      const basic = Buffer.from(`${id}:${secret}`).toString("base64");
      const response = await fetch("https://lsapi.seomoz.com/v2/url_metrics", {
        method: "POST",
        headers: { Authorization: `Basic ${basic}`, "content-type": "application/json" },
        body: JSON.stringify({ targets: ["moz.com"] }),
      });
      const payload = await readJson(response);
      if (!response.ok) return failure(response, payload);
      const result = (payload["results"] ?? [])[0];
      if (!result) return { ok: false, status: response.status, message: "Moz returned no metrics.", code: "PROVIDER_ERROR" };
      return { ok: true, status: response.status, message: "Live Moz API call succeeded.", label: "Moz Links API", accountRef: null, code: "CONNECTED" };
    }
    case "dataforseo": {
      const login = envValue(["DATAFORSEO_LOGIN"], creds);
      const password = envValue(["DATAFORSEO_PASSWORD"], creds);
      if (!login || !password) return notConfigured("DataForSEO login and password are required.");
      const basic = Buffer.from(`${login}:${password}`).toString("base64");
      const response = await fetch("https://api.dataforseo.com/v3/appendix/user_data", {
        headers: { Authorization: `Basic ${basic}` },
      });
      const payload = await readJson(response);
      if (!response.ok) return failure(response, payload);
      if (payload["status_code"] !== 20000) {
        return { ok: false, status: response.status, message: String(payload["status_message"] ?? "DataForSEO rejected the credentials.").slice(0, 300), code: "AUTHENTICATION_FAILED" };
      }
      return { ok: true, status: response.status, message: "Live DataForSEO API call succeeded.", label: "DataForSEO", accountRef: null, code: "CONNECTED" };
    }
    case "lovable_ai": {
      const key = envValue(["LOVABLE_API_KEY"], creds);
      if (!key) return notConfigured("The Cloud AI gateway key is not available in this environment.");
      const response = await fetch("https://ai.gateway.lovable.dev/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
      });
      const ok = response.ok;
      const body = ok ? "" : (await response.text()).slice(0, 200);
      return {
        ok,
        status: response.status,
        message: ok ? "Cloud AI gateway reachable." : `Cloud AI gateway returned HTTP ${response.status}. ${body}`.trim(),
        label: ok ? "Cloud AI gateway" : null,
        accountRef: null,
        code: outcomeFor(ok, response.status, body),
      };
    }
    case "openai": {
      const key = envValue(["OPENAI_API_KEY"], creds);
      if (!key) return notConfigured("No OpenAI API key is configured.");
      return simpleFetchTest("https://api.openai.com/v1/models?limit=1", { Authorization: `Bearer ${key}` }, (p) => ({
        ok: Array.isArray(p["data"]),
        message: "OpenAI rejected the API key.",
        label: "OpenAI API",
        ref: null,
      }));
    }
    case "anthropic": {
      const key = envValue(["ANTHROPIC_API_KEY"], creds);
      if (!key) return notConfigured("No Anthropic API key is configured.");
      return simpleFetchTest(
        "https://api.anthropic.com/v1/models?limit=1",
        { "x-api-key": key, "anthropic-version": "2023-06-01" },
        (p) => ({
          ok: Array.isArray(p["data"]),
          message: "Anthropic rejected the API key.",
          label: "Anthropic API",
          ref: null,
        }),
      );
    }
    case "resend_email": {
      const key = envValue(["RESEND_API_KEY"], creds);
      if (!key) return notConfigured("No Resend API key is configured.");
      return simpleFetchTest("https://api.resend.com/domains", { Authorization: `Bearer ${key}` }, (p) => ({
        ok: p["object"] === "list" || Array.isArray(p["data"]),
        message: "Resend rejected the API key.",
        label: "Resend email API",
        ref: null,
      }));
    }
    case "twilio_sms": {
      const sid = envValue(["TWILIO_ACCOUNT_SID"], creds);
      const token = envValue(["TWILIO_AUTH_TOKEN"], creds);
      if (!sid || !token) return notConfigured("Twilio account SID and auth token are required.");
      const basic = Buffer.from(`${sid}:${token}`).toString("base64");
      return simpleFetchTest(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`, { Authorization: `Basic ${basic}` }, (p) => ({
        ok: p["sid"] === sid,
        message: "Twilio rejected the credentials.",
        label: p["friendly_name"] ?? null,
        ref: p["sid"] ?? null,
      }));
    }
    case "stripe": {
      const key = envValue(["STRIPE_SECRET_KEY"], creds);
      if (!key) return notConfigured("No Stripe secret key is configured.");
      return simpleFetchTest("https://api.stripe.com/v1/balance", { Authorization: `Bearer ${key}` }, (p) => ({
        ok: p["object"] === "balance",
        message: "Stripe rejected the secret key.",
        label: "Stripe API",
        ref: null,
      }));
    }
    case "razorpay": {
      const id = envValue(["RAZORPAY_KEY_ID"], creds);
      const secret = envValue(["RAZORPAY_KEY_SECRET"], creds);
      if (!id || !secret) return notConfigured("Razorpay key ID and secret are required.");
      const basic = Buffer.from(`${id}:${secret}`).toString("base64");
      return simpleFetchTest("https://api.razorpay.com/v1/payments?count=1", { Authorization: `Basic ${basic}` }, (p) => ({
        ok: Array.isArray(p["items"]) || p["object"] === "collection",
        message: "Razorpay rejected the credentials.",
        label: "Razorpay API",
        ref: null,
      }));
    }
    case "serpapi": {
      const key = envValue(["SERPAPI_API_KEY"], creds);
      if (!key) return notConfigured("No SerpApi key is configured.");
      return simpleFetchTest(`https://serpapi.com/account?api_key=${encodeURIComponent(key)}`, {}, (p) => ({
        ok: Boolean(p["account_id"] ?? p["account_email"]),
        message: String(p["error"] ?? "SerpApi rejected the key."),
        label: p["account_email"] ?? "SerpApi",
        ref: p["account_id"] ?? null,
      }));
    }
    case "web_crawler": {
      const key = envValue(["FIRECRAWL_API_KEY"], creds);
      if (!key) return notConfigured("No Firecrawl API key is configured.");
      return simpleFetchTest("https://api.firecrawl.dev/v2/team/credit-usage", { Authorization: `Bearer ${key}` }, (p) => ({
        ok: p["success"] === true,
        message: String(p["error"] ?? "Firecrawl rejected the key."),
        label: "Firecrawl",
        ref: null,
      }));
    }
    case "pagespeed": {
      const key = envValue(["PAGESPEED_API_KEY", "GOOGLE_API_KEY"], creds);
      if (!key) return notConfigured("No PageSpeed Insights API key is configured.");
      return simpleFetchTest(
        `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent("https://example.com")}&strategy=mobile&key=${encodeURIComponent(key)}`,
        {},
        (p) => ({
          ok: Boolean(p["lighthouseResult"]),
          message: String(p["error"]?.["message"] ?? "PageSpeed returned no Lighthouse result."),
          label: "PageSpeed Insights",
          ref: null,
        }),
      );
    }
    case "url_reputation": {
      const key = envValue(["SAFE_BROWSING_API_KEY", "GOOGLE_API_KEY"], creds);
      if (!key) return notConfigured("No Safe Browsing API key is configured.");
      const response = await fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client: { clientId: "seovale", clientVersion: "1.0.0" },
          threatInfo: {
            threatTypes: ["MALWARE", "SOCIAL_ENGINEERING"],
            platformTypes: ["ANY_PLATFORM"],
            threatEntryTypes: ["URL"],
            threatEntries: [{ url: "https://example.com" }],
          },
        }),
      });
      const payload = await readJson(response);
      if (!response.ok) return failure(response, payload);
      return { ok: true, status: response.status, message: "Live API call succeeded.", label: "Google Safe Browsing", accountRef: null, code: "CONNECTED" };
    }
    case "uptime_monitor": {
      const key = envValue(["UPTIMEROBOT_API_KEY"], creds);
      if (!key) return notConfigured("No UptimeRobot API key is configured.");
      const response = await fetch("https://api.uptimerobot.com/v2/getAccountDetails", {
        method: "POST",
        headers: { "content-type": "application/json", "cache-control": "no-cache" },
        body: JSON.stringify({ api_key: key, format: "json" }),
      });
      const payload = await readJson(response);
      if (!response.ok) return failure(response, payload);
      if (payload["stat"] !== "ok") {
        return {
          ok: false,
          status: response.status,
          message: String(payload["error"]?.["message"] ?? "UptimeRobot rejected the key."),
          code: "INVALID_CREDENTIALS",
        };
      }
      return {
        ok: true,
        status: response.status,
        message: "Live API call succeeded.",
        label: payload["account"]?.["email"] ?? "UptimeRobot",
        accountRef: payload["account"]?.["email"] ?? null,
        code: "CONNECTED",
      };
    }
    case "ssl_monitor": {
      const host = accountRef?.replace(/^https?:\/\//, "").replace(/\/.*$/, "") ?? null;
      const response = await fetch(
        host
          ? `https://api.ssllabs.com/api/v3/analyze?host=${encodeURIComponent(host)}&fromCache=on&maxAge=24`
          : "https://api.ssllabs.com/api/v3/info",
      );
      const payload = await readJson(response);
      if (!response.ok) return failure(response, payload);
      return {
        ok: true,
        status: response.status,
        message: host ? `SSL Labs scan status for ${host}: ${payload["status"] ?? "unknown"}.` : "Live API call succeeded.",
        label: host ?? "Qualys SSL Labs",
        accountRef: host,
        code: "CONNECTED",
      };
    }
    case "dns_rdap": {
      const domain = accountRef?.replace(/^https?:\/\//, "").replace(/\/.*$/, "") ?? null;
      if (!domain) return { ok: false, status: 0, message: "Add the domain you want monitored first.", code: "NOT_CONFIGURED" };
      return simpleFetchTest(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {}, (p) => ({
        ok: Boolean(p["ldhName"] ?? p["handle"]),
        message: "RDAP returned no registration record for that domain.",
        label: p["ldhName"] ?? domain,
        ref: p["handle"] ?? domain,
      }));
    }
    default:
      return { ok: false, status: 0, message: `No live test is defined for ${providerId}.`, code: "UNAVAILABLE" };
  }
}

/**
 * Best-effort token revocation at the provider. Only providers with a
 * documented revoke endpoint are attempted; everything else reports
 * "unsupported" so the UI never claims a revocation that did not happen.
 */
export async function revokeOAuthToken(
  provider: string,
  accessToken: string,
): Promise<{ revoked: boolean; supported: boolean; message: string }> {
  const googleFamily = ["google_gmail", "youtube", "youtube_analytics", "google_search_console", "google_analytics", "google_ads"];
  try {
    if (googleFamily.includes(provider)) {
      const response = await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(accessToken)}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      return {
        revoked: response.ok,
        supported: true,
        message: response.ok ? "Access revoked at Google." : `Google revoke returned HTTP ${response.status}.`,
      };
    }
    if (provider === "facebook" || provider === "instagram" || provider === "whatsapp") {
      const response = await fetch(`https://graph.facebook.com/v21.0/me/permissions?access_token=${encodeURIComponent(accessToken)}`, {
        method: "DELETE",
      });
      return {
        revoked: response.ok,
        supported: true,
        message: response.ok ? "Permissions removed at Meta." : `Meta revoke returned HTTP ${response.status}.`,
      };
    }
    if (provider === "reddit") {
      const response = await fetch("https://www.reddit.com/api/v1/revoke_token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: accessToken, token_type_hint: "access_token" }).toString(),
      });
      return {
        revoked: response.ok,
        supported: true,
        message: response.ok ? "Token revoked at Reddit." : `Reddit revoke returned HTTP ${response.status}.`,
      };
    }
    if (provider === "twitter") {
      const response = await fetch("https://api.twitter.com/2/oauth2/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: accessToken, token_type_hint: "access_token" }).toString(),
      });
      return {
        revoked: response.ok,
        supported: true,
        message: response.ok ? "Token revoked at X." : `X revoke returned HTTP ${response.status}.`,
      };
    }
  } catch (caught) {
    return { revoked: false, supported: true, message: caught instanceof Error ? caught.message : "Revoke request failed." };
  }
  return { revoked: false, supported: false, message: "This provider offers no revoke endpoint; the stored access was deleted here." };
}
