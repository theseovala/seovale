// Update authorization: only a valid, active, domain-bound installation is told
// about newer signed releases. No artifact URL is returned here.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const Body = z.object({
  licenseKey: z.string().min(8).max(40),
  domain: z.string().min(3).max(253),
  installationRef: z.string().min(4).max(40),
  currentVersion: z.string().max(40),
  channel: z.enum(["stable", "beta"]).optional(),
});

function compareVersions(a: string, b: string) {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export const Route = createFileRoute("/api/public/license/update-check")({
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
        const { verifyRelease } = await import("@/lib/license/operations.server");

        const decision = await validateLicense(supabaseAdmin, {
          licenseKey: body.data.licenseKey,
          domain: body.data.domain,
          installationRef: body.data.installationRef,
          version: body.data.currentVersion,
          ip: request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for"),
          signature: request.headers.get("x-license-signature") ?? null,
          timestamp: request.headers.get("x-license-timestamp"),
          rawBody: raw,
        });
        if (!decision.ok) {
          return Response.json(
            { ok: false, result: decision.result, correlationId: decision.correlation },
            {
              status: decision.result === "rate_limited" ? 429 : 403,
              headers: { "Cache-Control": "no-store" },
            },
          );
        }

        const { data: release } = await supabaseAdmin
          .from("license_releases")
          .select(
            "release_ref, version, build_id, checksum_sha256, signature, signing_key_id, min_supported_version, published_at",
          )
          .eq("status", "published")
          .eq("channel", body.data.channel ?? "stable")
          .order("published_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!release || !verifyRelease(release)) {
          return Response.json(
            { ok: true, updateAvailable: false },
            { headers: { "Cache-Control": "no-store" } },
          );
        }
        const newer = compareVersions(release.version, body.data.currentVersion) > 0;
        const compatible =
          !release.min_supported_version ||
          compareVersions(body.data.currentVersion, release.min_supported_version) >= 0;

        return Response.json(
          {
            ok: true,
            updateAvailable: newer && compatible,
            compatible,
            version: release.version,
            buildId: release.build_id,
            checksum: release.checksum_sha256,
            signature: release.signature,
            signingKeyId: release.signing_key_id,
            // The package itself is only reachable through an authorized,
            // short-lived download token issued in the client portal.
            downloadRequiresAuthorization: true,
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      },
    },
  },
});
