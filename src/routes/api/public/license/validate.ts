// Backend-to-backend license validation for licensed deployments.
// Callers authenticate with an HMAC signature over the request body.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const Body = z.object({
  licenseKey: z.string().min(8).max(40),
  domain: z.string().min(3).max(253),
  installationRef: z.string().max(40).nullable().optional(),
  feature: z
    .enum(["SCAN", "REPORT", "CSV", "ADVANCED_AI", "INTEGRATIONS", "HISTORICAL_DATA", "API_ACCESS"])
    .nullable()
    .optional(),
  version: z.string().max(40).nullable().optional(),
});

export const Route = createFileRoute("/api/public/license/validate")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return Response.json({ ok: false, result: "bad_request" }, { status: 400 });
        }
        const body = Body.safeParse(parsed);
        if (!body.success)
          return Response.json({ ok: false, result: "bad_request" }, { status: 400 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { validateLicense } = await import("@/lib/license/authority.server");

        const decision = await validateLicense(supabaseAdmin, {
          licenseKey: body.data.licenseKey,
          domain: body.data.domain,
          installationRef: body.data.installationRef ?? null,
          feature: body.data.feature ?? null,
          version: body.data.version ?? null,

          rawBody: raw,
          signature: request.headers.get("x-license-signature") ?? null,
          timestamp: request.headers.get("x-license-timestamp"),
          ip: request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for"),
        });

        // Minimal response: no internal identifiers, no license-server logic.
        const status = decision.ok ? 200 : decision.result === "rate_limited" ? 429 : 403;
        return Response.json(
          decision.ok
            ? {
                ok: true,
                status: decision.license?.status,
                features: decision.license?.features,
                expiresAt: decision.license?.expiresAt,
                installationRef: decision.license?.installationRef,
                grace: decision.grace,
                correlationId: decision.correlation,
              }
            : { ok: false, result: decision.result, correlationId: decision.correlation },
          {
            status,
            headers: {
              "Cache-Control": "no-store",
              ...(decision.retryAfterSeconds
                ? { "Retry-After": String(decision.retryAfterSeconds) }
                : {}),
            },
          },
        );
      },
    },
  },
});
