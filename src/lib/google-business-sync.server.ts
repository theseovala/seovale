import { decryptSecret, encryptSecret } from "./google-business.server";

const ACCOUNTS_API = "https://mybusinessaccountmanagement.googleapis.com/v1";
const INFO_API = "https://mybusinessbusinessinformation.googleapis.com/v1";
const REVIEWS_API = "https://mybusiness.googleapis.com/v4";
const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

type Connection = { access_token_ciphertext: string; refresh_token_ciphertext: string; token_expires_at: string };
export type GoogleLocation = {
  externalRef: string;
  name: string;
  city: string;
  country: string;
  account: string;
  resource: string;
  /**
   * The place id Google returned for this location, kept separate from
   * `externalRef` because `externalRef` falls back to the resource name. Only a
   * real place id can be turned into a link, so the two must not be confused.
   */
  placeId: string | null;
};
export type GoogleReview = { id: string; author: string; rating: number; body: string; createdAt: string };

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

async function googleGet(url: string, accessToken: string) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (response.status === 403) throw new Error("Google Business Profile API access has not been approved for this OAuth client.");
  if (!response.ok) throw new Error(`Google Business Profile request failed (${response.status}).`);
  return (await response.json()) as Record<string, any>;
}

export async function usableAccessToken(admin: any, workspaceId: string, connection: Connection) {
  if (Date.parse(connection.token_expires_at) - Date.now() > 120_000) {
    return decryptSecret(connection.access_token_ciphertext);
  }
  const { loadProviderCredentials } = await import("./integrations/credentials.server");
  const creds = await loadProviderCredentials(admin, workspaceId, "google_business");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: await decryptSecret(connection.refresh_token_ciphertext),
      client_id: creds["GOOGLE_BUSINESS_CLIENT_ID"] ?? requiredEnv("GOOGLE_BUSINESS_CLIENT_ID"),
      client_secret: creds["GOOGLE_BUSINESS_CLIENT_SECRET"] ?? requiredEnv("GOOGLE_BUSINESS_CLIENT_SECRET"),
      grant_type: "refresh_token",
    }),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok || typeof payload["access_token"] !== "string") throw new Error("Google access expired. Reconnect the account.");
  await admin.from("google_business_connections").update({
    access_token_ciphertext: await encryptSecret(payload["access_token"]),
    token_expires_at: new Date(Date.now() + (typeof payload["expires_in"] === "number" ? payload["expires_in"] : 3600) * 1000).toISOString(),
    status: "connected",
    last_error: null,
  }).eq("workspace_id", workspaceId);
  return payload["access_token"];
}

async function accounts(token: string) {
  const result: string[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${ACCOUNTS_API}/accounts`);
    url.searchParams.set("pageSize", "20");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const payload = await googleGet(url.toString(), token);
    for (const account of (payload["accounts"] ?? []) as Array<{ name?: string }>) if (account.name) result.push(account.name);
    pageToken = typeof payload["nextPageToken"] === "string" ? payload["nextPageToken"] : undefined;
  } while (pageToken && result.length < 100);
  return result;
}

async function locations(account: string, token: string) {
  const result: GoogleLocation[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${INFO_API}/${account}/locations`);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("readMask", "name,title,storefrontAddress,metadata");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const payload = await googleGet(url.toString(), token);
    for (const row of (payload["locations"] ?? []) as Array<Record<string, any>>) {
      const resource = typeof row["name"] === "string" ? row["name"] : "";
      if (!resource) continue;
      const address = row["storefrontAddress"] ?? {};
      const placeId = typeof row["metadata"]?.["placeId"] === "string" ? row["metadata"]["placeId"] : null;
      result.push({
        externalRef: placeId ?? resource,
        name: row["title"] ?? "Google Business location",
        city: address["locality"] ?? "Unknown city",
        country: address["regionCode"] ?? "Unknown country",
        account,
        resource,
        placeId,
      });
    }
    pageToken = typeof payload["nextPageToken"] === "string" ? payload["nextPageToken"] : undefined;
  } while (pageToken && result.length < 200);
  return result;
}

async function reviews(location: GoogleLocation, token: string, limit: number) {
  const result: GoogleReview[] = [];
  const locationId = location.resource.split("/").pop();
  if (!locationId) return result;
  let pageToken: string | undefined;
  do {
    const url = new URL(`${REVIEWS_API}/${location.account}/locations/${locationId}/reviews`);
    url.searchParams.set("pageSize", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const payload = await googleGet(url.toString(), token);
    for (const row of (payload["reviews"] ?? []) as Array<Record<string, any>>) {
      const reviewId = row["reviewId"] ?? row["name"];
      if (!reviewId) continue;
      result.push({
        id: `gbp:${locationId}:${reviewId}`,
        author: row["reviewer"]?.["displayName"] ?? "Google user",
        rating: STARS[row["starRating"] as string] ?? 0,
        body: row["comment"] ?? "Rating submitted without written feedback.",
        createdAt: row["createTime"] ?? new Date().toISOString(),
      });
      if (result.length >= limit) return result;
    }
    pageToken = typeof payload["nextPageToken"] === "string" ? payload["nextPageToken"] : undefined;
  } while (pageToken);
  return result;
}

/**
 * Publishes a public reply to one Google review. `externalId` is the stored
 * `gbp:<locationId>:<reviewId>` reference; the owning account is resolved from Google.
 */
export async function postGoogleReviewReply(token: string, externalId: string, comment: string) {
  const parts = externalId.split(":");
  if (parts[0] !== "gbp" || parts.length < 3) throw new Error("This review did not come from Google Business Profile.");
  const locationId = parts[1];
  const reviewId = parts.slice(2).join(":");
  let lastStatus = 0;
  for (const account of await accounts(token)) {
    const response = await fetch(`${REVIEWS_API}/${account}/locations/${locationId}/reviews/${reviewId}/reply`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ comment }),
    });
    if (response.ok) return true;
    lastStatus = response.status;
    if (response.status !== 404 && response.status !== 403) {
      throw new Error(`Google rejected the reply (${response.status}).`);
    }
  }
  throw new Error(`Google did not accept the reply${lastStatus ? ` (${lastStatus})` : ""}.`);
}

export async function fetchGoogleReviews(token: string, perLocation = 100) {
  const result: Array<{ location: GoogleLocation; reviews: GoogleReview[] }> = [];
  for (const account of await accounts(token)) {
    for (const location of await locations(account, token)) result.push({ location, reviews: await reviews(location, token, perLocation) });
  }
  return result;
}