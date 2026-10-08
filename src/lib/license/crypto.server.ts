/**
 * Server-only cryptography for the license authority.
 * Nothing here may be imported from browser code: every secret is read from
 * the server environment and no raw secret is ever returned to a client.
 */
import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
  webcrypto,
} from "node:crypto";

function requireSecret(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

export const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

/** Peppered hash: stored instead of the raw token so a database read cannot replay it. */
export function hashToken(value: string) {
  return createHmac("sha256", requireSecret("LICENSE_TOKEN_PEPPER")).update(value).digest("hex");
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/* ---------- Release / license signing (HMAC-SHA256 over a canonical payload) ---------- */

export function signPayload(payload: Record<string, unknown>) {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return createHmac("sha256", requireSecret("LICENSE_SIGNING_SECRET"))
    .update(canonical)
    .digest("base64url");
}

export function verifyPayload(payload: Record<string, unknown>, signature: string) {
  try {
    return safeEqual(signPayload(payload), signature);
  } catch {
    return false;
  }
}

export const SIGNING_KEY_ID = () => sha256Hex(requireSecret("LICENSE_SIGNING_SECRET")).slice(0, 16);

/* ---------- MFA secret encryption (AES-GCM, key derived from a server secret) ---------- */

async function mfaKey() {
  const raw = createHash("sha256").update(requireSecret("LICENSE_MFA_ENCRYPTION_KEY")).digest();
  return webcrypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

export async function encryptSecret(value: string) {
  const iv = randomBytes(12);
  const encrypted = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await mfaKey(),
    new TextEncoder().encode(value),
  );
  return `${b64(iv)}.${b64(new Uint8Array(encrypted))}`;
}

export async function decryptSecret(value: string) {
  const [iv, payload] = value.split(".");
  if (!iv || !payload) throw new Error("Stored secret is invalid.");
  const decrypted = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(iv, "base64url") },
    await mfaKey(),
    Buffer.from(payload, "base64url"),
  );
  return new TextDecoder().decode(decrypted);
}

/* ---------- TOTP (RFC 6238, SHA-1, 6 digits, 30s step) ---------- */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buffer: Buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input: string) {
  const clean = input.replace(/=+$/, "").toUpperCase().replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error("Invalid authenticator secret.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret() {
  return base32Encode(randomBytes(20));
}

function totpAt(secret: string, counter: number) {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac("sha1", base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

/** Accepts the current step plus one step either side to tolerate clock drift. */
export function verifyTotp(secret: string, code: string) {
  const cleaned = code.replace(/\D/g, "");
  if (cleaned.length !== 6) return false;
  const counter = Math.floor(Date.now() / 30_000);
  for (const drift of [-1, 0, 1]) {
    if (safeEqual(totpAt(secret, counter + drift), cleaned)) return true;
  }
  return false;
}

export function otpauthUri(email: string, secret: string) {
  return `otpauth://totp/${encodeURIComponent(`Seovale:${email}`)}?secret=${secret}&issuer=Seovale&algorithm=SHA1&digits=6&period=30`;
}

/* ---------- Identifiers ---------- */

const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alike characters

function randomGroup(length: number) {
  let out = "";
  for (let i = 0; i < length; i += 1) out += KEY_ALPHABET[randomInt(KEY_ALPHABET.length)];
  return out;
}

/** Unpredictable, non-sequential license key: SVL-XXXX-XXXX-XXXX. */
export function generateLicenseKey() {
  return `SVL-${randomGroup(4)}-${randomGroup(4)}-${randomGroup(4)}`;
}

export function generateInstallationRef() {
  return `INS-${randomGroup(4)}-${randomGroup(4)}-${randomGroup(4)}`;
}

export function generateReleaseRef() {
  return `REL-${randomGroup(4)}-${randomGroup(4)}`;
}

export function generateRecoveryCodes(count = 8) {
  return Array.from({ length: count }, () => `${randomGroup(5)}-${randomGroup(5)}`);
}

export function correlationId() {
  return randomBytes(8).toString("hex");
}

/** IP is never stored raw — only a peppered hash used for abuse detection. */
export function hashIp(ip: string | null | undefined) {
  if (!ip) return null;
  return hashToken(`ip:${ip}`);
}
