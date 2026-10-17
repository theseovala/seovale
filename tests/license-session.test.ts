// Isolated cryptographic fixtures only: no provider calls or production writes.
import { describe, expect, test } from "bun:test";
import { sessionExpiry, signSessionPayload, verifySessionToken, SESSION_TTL_MS } from "../src/lib/license/session.server";
import { buildRequestSignature, verifyRequestSignature } from "../src/lib/license/authority.server";

const now = 1_800_000_000_000;
const secret = "isolated-test-secret";
const binding = { licenseKey: "fixture-license", domain: "client.test", installationRef: "fixture-installation", subject: "fixture-user" };
const claims = { lic: binding.licenseKey, dom: binding.domain, ins: binding.installationRef, sub: binding.subject, iat: now, exp: now + 60_000 };
function token(value: Record<string, unknown> = claims) {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${signSessionPayload(payload, secret)}`;
}

describe("client license pass", () => {
  test("accepts a correctly signed pass with matching bindings", () => {
    expect(verifySessionToken(token(), secret, binding, now)?.subject).toBe("fixture-user");
  });
  test("rejects an expired pass", () => {
    expect(verifySessionToken(token(), secret, binding, now + 60_000)).toBeNull();
  });
  test("rejects a different domain", () => {
    expect(verifySessionToken(token(), secret, { ...binding, domain: "wrong.test" }, now)).toBeNull();
  });
  test("rejects a different installation", () => {
    expect(verifySessionToken(token(), secret, { ...binding, installationRef: "wrong-install" }, now)).toBeNull();
  });
  test("rejects a pass for a different login subject", () => {
    expect(verifySessionToken(token(), secret, { ...binding, subject: "other-user" }, now)).toBeNull();
  });
  test("rejects a forged signature", () => {
    expect(verifySessionToken(token(), "wrong-secret", binding, now)).toBeNull();
  });
  test("rejects trailing token segments", () => {
    expect(verifySessionToken(`${token()}.extra`, secret, binding, now)).toBeNull();
  });
  test("limits passes to 15 minutes", () => {
    expect(sessionExpiry(now, null)).toBe(now + 900_000);
    expect(verifySessionToken(token({ ...claims, exp: now + SESSION_TTL_MS + 1 }), secret, binding, now)).toBeNull();
  });
  test("caps pass expiry at the license expiry", () => {
    expect(sessionExpiry(now, new Date(now + 30_000).toISOString())).toBe(now + 30_000);
  });
  test("refuses an already expired license", () => {
    expect(() => sessionExpiry(now, new Date(now).toISOString())).toThrow();
  });
  test("requires a signed client request", () => {
    expect(verifyRequestSignature("{}", null, null, secret).ok).toBe(false);
  });
  test("accepts the exact signed body and rejects changed input", () => {
    const timestamp = String(Date.now());
    const signature = buildRequestSignature("{}", timestamp, secret);
    expect(verifyRequestSignature("{}", signature, timestamp, secret).ok).toBe(true);
    expect(verifyRequestSignature('{"changed":true}', signature, timestamp, secret).ok).toBe(false);
  });
});