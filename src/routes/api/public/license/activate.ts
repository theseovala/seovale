// Installation registration for a licensed deployment (domain + license bound).
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const Body = z.object({
  licenseKey: z.string().min(8).max(40),
  domain: z.string().min(3).max(253),
  // A deployment-generated identifier; no personal or device data is accepted.
  fingerprint: z.string().min(8).max(200),
  version: z.string().max(40).nullable().optional(),
});

export const Route = createFileRoute("/api/public/license/activate")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let parsed: unknown;
        try {
          parsed = await request.json();
        } catch {
          return Response.json({ ok: false, result: "bad_request" }, { status: 400 });
        }
        const body = Body.safeParse(parsed);
        if (!body.success)
          return Response.json({ ok: false, result: "bad_request" }, { status: 400 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { activateInstallation } = await import("@/lib/license/operations.server");

        const outcome = await activateInstallation(supabaseAdmin, {
          licenseKey: body.data.licenseKey,
          domain: body.data.domain,
          fingerprint: body.data.fingerprint,
          version: body.data.version ?? null,
          ip: request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for"),
        });

        if (!outcome.ok) {
          return Response.json(
            { ok: false, result: outcome.result, message: outcome.message },
            {
              status: outcome.result === "rate_limited" ? 429 : 403,
              headers: {
                "Cache-Control": "no-store",
                ...(outcome.retryAfterSeconds
                  ? { "Retry-After": String(outcome.retryAfterSeconds) }
                  : {}),
              },
            },
          );
        }
        return Response.json(
          {
            ok: true,
            installationRef: outcome.installationRef,
            features: outcome.features,
            expiresAt: outcome.expiresAt,
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      },
    },
  },
});
