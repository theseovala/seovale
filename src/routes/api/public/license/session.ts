// Client-login license session.
// A licensed deployment calls this on every end-user login ("issue") and before
// trusting a session again ("verify"). Every call re-runs full server-side
// validation (status, expiry, domain binding, installation binding), so a
// suspend/revoke/expiry takes effect on the very next check. Issued tokens are
// short-lived (max 15 min, never past license expiry) and HMAC-signed with the
// license secret, so the deployment can verify them locally without the server.
import { createFileRoute } from "@tanstack/react-router";
import { createHmac } from "node:crypto";
import { z } from "zod";

const SESSION_TTL_MS = 15 * 60 * 1000;

const Body = z.object({
  action: z.enum(["issue", "verify"]),
  licenseKey: z.string().min(8).max(40),
  domain: z.string().min(3).max(253),
  installationRef: z.string().min(4).max(40),
  subject: z.string().min(1).max(200).optional(), // deployment's own user id (opaque)
  sessionToken: z.string().max(2000).optional(),
});

function b64(input: string) {
  return Buffer.from(input).toString("base64url");
}

export const Route = createFileRoute("/api/public/license/session")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const headers = { "Cache-Control": "no-store" };
        const raw = await request.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return Response.json({ ok: false, result: "bad_request" }, { status: 400, headers });
        }
        const body = Body.safeParse(parsed);
        if (!body.success) return Response.json({ ok: false, result: "bad_request" }, { status: 400, headers });
        if (body.data.action === "verify" && !body.data.sessionToken) {
          return Response.json({ ok: false, result: "bad_request" }, { status: 400, headers });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { validateLicense, recordLicenseEvent } = await import("@/lib/license/authority.server");
        const { decryptSecret, safeEqual } = await import("@/lib/license/crypto.server");

        const decision = await validateLicense(supabaseAdmin, {
          licenseKey: body.data.licenseKey,
          domain: body.data.domain,
          installationRef: body.data.installationRef,
          rawBody: raw,
          signature: request.headers.get("x-license-signature") ?? null,
          timestamp: request.headers.get("x-license-timestamp"),
          ip: request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for"),
        });
        if (!decision.ok || !decision.license) {
          const status = decision.result === "rate_limited" ? 429 : 403;
          return Response.json({ ok: false, result: decision.result, correlationId: decision.correlation }, { status, headers });
        }

        const { data: license } = await supabaseAdmin
          .from("licenses")
          .select("id, client_id, secret_hash")
          .eq("license_key", decision.license.licenseKey)
          .single();
        if (!license) return Response.json({ ok: false, result: "license_not_found" }, { status: 403, headers });
        const secret = await decryptSecret(license.secret_hash);
        const sign = (payload: string) => createHmac("sha256", secret).update(payload).digest("base64url");

        if (body.data.action === "verify") {
          const [payload, sig] = (body.data.sessionToken ?? "").split(".");
          let claims: { lic?: string; dom?: string; ins?: string; exp?: number } = {};
          try {
            claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString());
          } catch {
            /* falls through to rejection */
          }
          const valid =
            Boolean(payload && sig) &&
            safeEqual(sign(payload!), sig!) &&
            claims.lic === decision.license.licenseKey &&
            claims.dom === decision.license.domain &&
            claims.ins === decision.license.installationRef &&
            typeof claims.exp === "number" &&
            claims.exp > Date.now();
          if (!valid) {
            return Response.json({ ok: false, result: "session_invalid", correlationId: decision.correlation }, { status: 401, headers });
          }
          return Response.json({ ok: true, result: "valid", expiresAt: new Date(claims.exp!).toISOString(), licenseExpiresAt: decision.license.expiresAt, correlationId: decision.correlation }, { headers });
        }

        const licenseExp = decision.license.expiresAt ? new Date(decision.license.expiresAt).getTime() : Infinity;
        const exp = Math.min(Date.now() + SESSION_TTL_MS, licenseExp);
        const payload = b64(
          JSON.stringify({
            lic: decision.license.licenseKey,
            dom: decision.license.domain,
            ins: decision.license.installationRef,
            sub: body.data.subject ?? null,
            features: decision.license.features,
            iat: Date.now(),
            exp,
          }),
        );
        await recordLicenseEvent(supabaseAdmin, {
          licenseId: license.id,
          clientId: license.client_id,
          eventType: "client_session_issued",
          result: "success",
          correlation: decision.correlation,
          metadata: { domain: decision.license.domain, installation: decision.license.installationRef },
        });
        return Response.json(
          {
            ok: true,
            sessionToken: `${payload}.${sign(payload)}`,
            expiresAt: new Date(exp).toISOString(),
            licenseExpiresAt: decision.license.expiresAt,
            features: decision.license.features,
            correlationId: decision.correlation,
          },
          { headers },
        );
      },
    },
  },
});
