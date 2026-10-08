// Secure download endpoint: redeems a short-lived, single-use download token.
// No permanent public URL exists for any release artifact.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/license/download")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = new URL(request.url).searchParams.get("token");
        if (!token) return new Response("Missing download token.", { status: 400 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { redeemDownloadToken } = await import("@/lib/license/operations.server");

        const outcome = await redeemDownloadToken(
          supabaseAdmin,
          token,
          request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for"),
        );
        if (!outcome.ok) {
          return new Response(outcome.message, {
            status: outcome.status,
            headers: { "Cache-Control": "no-store" },
          });
        }
        return new Response(null, {
          status: 302,
          headers: {
            Location: outcome.url,
            "X-Artifact-Checksum": outcome.checksum,
            "Cache-Control": "no-store",
          },
        });
      },
    },
  },
});
