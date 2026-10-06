import { createHash, randomBytes, webcrypto } from "node:crypto";

const BUSINESS_SCOPE = "https://www.googleapis.com/auth/business.manage";

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function base64Url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url");
}

async function encryptionKey() {
  const raw = createHash("sha256").update(requiredEnv("GOOGLE_BUSINESS_TOKEN_ENCRYPTION_KEY")).digest();
  return webcrypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(value: string) {
  const iv = randomBytes(12);
  const encrypted = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(),
    new TextEncoder().encode(value),
  );
  return `${base64Url(iv)}.${base64Url(new Uint8Array(encrypted))}`;
}

export async function decryptSecret(value: string) {
  const [iv, payload] = value.split(".");
  if (!iv || !payload) throw new Error("Stored Google credential is invalid.");
  const decrypted = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(iv, "base64url") },
    await encryptionKey(),
    Buffer.from(payload, "base64url"),
  );
  return new TextDecoder().decode(decrypted);
}

export function hashValue(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

const ALLOWED_HOST_SUFFIXES = [".lovable.app", ".lovableproject.com", ".lovable.dev", "seovale.com"];
const STABLE_PREVIEW_ORIGIN = "https://id-preview--3909161c-29f3-4466-a802-1204f20720c3.lovable.app";

export function assertAllowedOrigin(origin: string) {
  const url = new URL(origin);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !local) throw new Error("Google connection requires HTTPS.");
  const allowed =
    local ||
    ALLOWED_HOST_SUFFIXES.some((suffix) => url.hostname === suffix.replace(/^\./, "") || url.hostname.endsWith(suffix));
  if (!allowed) throw new Error("This origin is not allowed.");
  return url.origin;
}

export function googleCallbackOrigin(returnOrigin: string) {
  const url = new URL(returnOrigin);
  return url.hostname.endsWith(".lovableproject.com") ? STABLE_PREVIEW_ORIGIN : url.origin;
}

type Creds = Record<string, string>;
const credOrEnv = (creds: Creds, name: string) => {
  const value = creds[name] ?? process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
};

export function createGoogleAuthorization(redirectUri: string, creds: Creds = {}) {
  const state = base64Url(randomBytes(32));
  const verifier = base64Url(randomBytes(48));
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", credOrEnv(creds, "GOOGLE_BUSINESS_CLIENT_ID"));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", `${BUSINESS_SCOPE} openid email`);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent select_account");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { state, verifier, url: url.toString() };
}

export async function exchangeGoogleCode(code: string, verifier: string, redirectUri: string, creds: Creds = {}) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      code_verifier: verifier,
      client_id: credOrEnv(creds, "GOOGLE_BUSINESS_CLIENT_ID"),
      client_secret: credOrEnv(creds, "GOOGLE_BUSINESS_CLIENT_SECRET"),
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok || typeof payload["access_token"] !== "string") {
    throw new Error("Google did not authorize Business Profile access.");
  }
  return {
    accessToken: payload["access_token"],
    refreshToken: typeof payload["refresh_token"] === "string" ? payload["refresh_token"] : null,
    expiresIn: typeof payload["expires_in"] === "number" ? payload["expires_in"] : 3600,
    scopes: typeof payload["scope"] === "string" ? payload["scope"].split(" ") : [],
  };
}

export async function getGoogleAccountEmail(accessToken: string) {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as { email?: string };
  return payload.email ?? null;
}