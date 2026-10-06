// Scheduled review-removal scan. Called by the database scheduler; runs only
// for workspaces whose configured interval is due, one bounded batch each.
import { createFileRoute } from "@tanstack/react-router";

const MAX_WORKSPACES_PER_RUN = 5;
const LEASE_MINUTES = 15;

export const Route = createFileRoute("/api/public/removal-scan")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // The scheduler authenticates with a private token stored in the
        // database; the platform cron secret is also accepted.
        const bearer = /^Bearer ([^\s,]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
        const { data: tokenRow } = await supabaseAdmin
          .from("scheduler_tokens")
          .select("token")
          .eq("name", "removal-scan")
          .maybeSingle();
        if (!bearer || bearer !== tokenRow?.token) {
          const { authenticateCronRequest } = await import("@/integrations/supabase/cron-auth");
          const denied = await authenticateCronRequest(request);
          if (denied) return denied;
        }


        const { runRemovalScan } = await import("@/lib/removal-scan.server");
        const now = new Date();

        const { data: due, error } = await supabaseAdmin
          .from("removal_scan_settings")
          .select("workspace_id, interval_minutes, batch_size, lease_expires_at")
          .eq("enabled", true)
          .is("paused_reason", null)
          .lte("next_run_at", now.toISOString())
          .order("next_run_at")
          .limit(MAX_WORKSPACES_PER_RUN);
        if (error) {
          return Response.json({ error: error.message }, { status: 500 });
        }

        const results: Array<{ workspace_id: string; checked: number; flagged: number }> = [];

        for (const row of due ?? []) {
          // Single-flight lease so two overlapping runs never scan together.
          const lease = new Date(Date.now() + LEASE_MINUTES * 60_000).toISOString();
          const { data: claimed } = await supabaseAdmin
            .from("removal_scan_settings")
            .update({ lease_expires_at: lease })
            .eq("workspace_id", row.workspace_id)
            .or(`lease_expires_at.is.null,lease_expires_at.lt.${now.toISOString()}`)
            .select("workspace_id")
            .maybeSingle();
          if (!claimed) continue;

          const next = new Date(Date.now() + row.interval_minutes * 60_000).toISOString();
          try {
            const outcome = await runRemovalScan(
              supabaseAdmin,
              row.workspace_id,
              row.batch_size,
              null,
            );
            await supabaseAdmin
              .from("removal_scan_settings")
              .update({
                last_run_at: new Date().toISOString(),
                next_run_at: next,
                lease_expires_at: null,
              })
              .eq("workspace_id", row.workspace_id);
            results.push({ workspace_id: row.workspace_id, ...outcome });
          } catch (scanError) {
            const message = scanError instanceof Error ? scanError.message : "Scheduled scan failed";
            // Circuit breaker: credit, policy or access failures pause the job
            // until the workspace owner resumes it.
            const terminal = /402|403|credit|insufficient|not allowed|denied/i.test(message);
            await supabaseAdmin
              .from("removal_scan_settings")
              .update({
                last_run_at: new Date().toISOString(),
                next_run_at: next,
                lease_expires_at: null,
                ...(terminal ? { paused_reason: message.slice(0, 300) } : {}),
              })
              .eq("workspace_id", row.workspace_id);
          }
        }

        return Response.json({ ran: results.length, results });
      },
    },
  },
});
