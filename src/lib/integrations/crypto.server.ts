import { createHash, randomBytes, webcrypto } from "node:crypto";

function encryptionSecret() {
  const value =
    process.env["INTEGRATION_TOKEN_ENCRYPTION_KEY"] ??
    process.env["GOOGLE_BUSINESS_TOKEN_ENCRYPTION_KEY"];
  if (!value) throw new Error("INTEGRATION_TOKEN_ENCRYPTION_KEY is not configured.");
  return value;
}

async function key() {
  const raw = createHash("sha256").update(encryptionSecret()).digest();
  return webcrypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

export async function encryptValue(value: string) {
  const iv = randomBytes(12);
  const encrypted = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await key(),
    new TextEncoder().encode(value),
  );
  return `${b64(iv)}.${b64(new Uint8Array(encrypted))}`;
}

export async function decryptValue(value: string) {
  const [iv, payload] = value.split(".");
  if (!iv || !payload) throw new Error("Stored credential is invalid.");
  const decrypted = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(iv, "base64url") },
    await key(),
    Buffer.from(payload, "base64url"),
  );
  return new TextDecoder().decode(decrypted);
}

export const hashState = (value: string) => createHash("sha256").update(value).digest("hex");

export function randomToken(bytes = 32) {
  return b64(randomBytes(bytes));
}

export function pkce() {
  const verifier = randomToken(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
