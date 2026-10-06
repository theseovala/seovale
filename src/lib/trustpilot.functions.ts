import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type Ctx = { supabase: any; userId: string };

async function workspace(context: Ctx) {
  const { data, error } = await context.supabase
    .from("workspace_members")
    .select("workspace_id, role")
    .eq("user_id", context.userId)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("No workspace is assigned to this account.");
  return data as { workspace_id: string; role: string };
}

/**
 * Pulls real reviews from the Trustpilot Business API using the stored API key
 * and the resolved business unit, then upserts them into the reviews table.
 * Nothing is fabricated: every row comes from the live Trustpilot response.
 */
export const syncTrustpilotReviews = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const member = await workspace(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { loadProviderCredentials } = await import("@/lib/integrations/credentials.server");

    const creds = await loadProviderCredentials(supabaseAdmin, member.workspace_id, "trustpilot");
    const apiKey = creds["TRUSTPILOT_API_KEY"] ?? process.env["TRUSTPILOT_API_KEY"];
    if (!apiKey) throw new Error("Add your Trustpilot API key in the Integration Manager first.");

    const { data: connection } = await supabaseAdmin
      .from("integration_connections")
      .select("account_ref,account_label,status")
      .eq("workspace_id", member.workspace_id)
      .eq("provider", "trustpilot")
      .maybeSingle();
    if (!connection?.account_ref || connection.status !== "connected") {
      throw new Error("Connect Trustpilot in the Integration Manager first (save the key, set your business domain and verify).");
    }

    const { data: run, error: runError } = await context.supabase
      .from("sync_runs")
      .insert({ workspace_id: member.workspace_id, platform: "trustpilot" })
      .select("id")
      .single();
    if (runError) throw runError;

    const startedAt = Date.now();
    try {
      const url = new URL(`https://api.trustpilot.com/v1/business-units/${encodeURIComponent(connection.account_ref)}/reviews`);
      url.searchParams.set("apikey", apiKey);
      url.searchParams.set("perPage", "100");
      const response = await fetch(url.toString(), { headers: { accept: "application/json" } });
      const payload = await response.json().catch(() => ({}));
      await supabaseAdmin.from("integration_api_logs").insert({
        workspace_id: member.workspace_id,
        provider: "trustpilot",
        operation: "reviews_sync",
        method: "GET",
        endpoint: "/v1/business-units/{id}/reviews",
        http_status: response.status,
        duration_ms: Date.now() - startedAt,
        outcome_code: response.ok ? "CONNECTED" : response.status === 401 || response.status === 403 ? "INVALID_CREDENTIALS" : "PROVIDER_ERROR",
        error_message: response.ok ? null : (payload?.message ?? `Trustpilot returned HTTP ${response.status}`),
      });
      if (!response.ok) {
        throw new Error(payload?.message ?? `Trustpilot sync failed with HTTP ${response.status}.`);
      }

      const reviews = Array.isArray(payload?.reviews) ? payload.reviews : [];
      const locationName = connection.account_label ?? "Trustpilot";
      const { data: rules } = await context.supabase
        .from("alert_rules")
        .select("negative_rating_threshold")
        .eq("workspace_id", member.workspace_id)
        .maybeSingle();

      let created = 0;
      let updated = 0;
      let alerts = 0;
      for (const review of reviews) {
        const rating = typeof review.stars === "number" ? review.stars : 0;
        if (!review.id || rating < 1) continue;
        const author = review.consumer?.displayName ?? "Trustpilot reviewer";
        const body = [review.title, review.text].filter(Boolean).join(" — ") || "(no written review)";
        const createdAt = review.createdAt ?? new Date().toISOString();
        const sentiment = rating >= 4 ? "positive" : rating === 3 ? "neutral" : "negative";
        const priority = rating <= 2 ? "high" : rating === 3 ? "medium" : "low";
        const reply = review.reply?.message ?? null;

        const { data: existing } = await context.supabase
          .from("reviews")
          .select("id")
          .eq("workspace_id", member.workspace_id)
          .eq("platform", "trustpilot")
          .eq("external_id", String(review.id))
          .maybeSingle();

        let storedReviewId: string;
        if (existing) {
          const { error: updateError } = await context.supabase
            .from("reviews")
            .update({ author, rating, body, sentiment, priority, location_name: locationName, external_created_at: createdAt, ...(reply ? { reply } : {}) })
            .eq("id", existing.id);
          if (updateError) throw updateError;
          storedReviewId = existing.id;
          updated += 1;
        } else {
          const { data: inserted, error: insertError } = await context.supabase
            .from("reviews")
            .insert({
              workspace_id: member.workspace_id,
              platform: "trustpilot",
              external_id: String(review.id),
              source: "trustpilot",
              author,
              rating,
              sentiment,
              status: reply ? "replied" : "pending",
              priority,
              location_name: locationName,
              body,
              reply,
              replied_at: reply ? (review.reply?.publishedAt ?? createdAt) : null,
              external_created_at: createdAt,
            })
            .select("id")
            .single();
          if (insertError) throw insertError;
          storedReviewId = inserted.id;
          created += 1;
        }

        if (rating <= (rules?.negative_rating_threshold ?? 2)) {
          const { data: existingAlert } = await context.supabase
            .from("alerts")
            .select("id")
            .eq("workspace_id", member.workspace_id)
            .eq("review_id", storedReviewId)
            .eq("kind", "negative_review")
            .limit(1)
            .maybeSingle();
          if (!existingAlert) {
            const { error: alertError } = await context.supabase.from("alerts").insert({
              workspace_id: member.workspace_id,
              review_id: storedReviewId,
              kind: "negative_review",
              severity: rating === 1 ? "critical" : "high",
              title: `${rating}-star Trustpilot review`,
              detail: body.slice(0, 240),
              location_name: locationName,
            });
            if (alertError) throw alertError;
            alerts += 1;
          }
        }
      }

      const now = new Date().toISOString();
      await context.supabase
        .from("sync_runs")
        .update({ status: "completed", locations_found: 1, reviews_found: reviews.length, reviews_created: created, reviews_updated: updated, alerts_created: alerts, completed_at: now })
        .eq("id", run.id);
      await context.supabase
        .from("connected_platforms")
        .update({ status: "connected", last_synced_at: now, last_sync_error: null })
        .eq("workspace_id", member.workspace_id)
        .eq("platform", "trustpilot");
      return { reviewsFound: reviews.length, reviewsCreated: created, reviewsUpdated: updated, alertsCreated: alerts };
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Trustpilot sync failed";
      await context.supabase
        .from("sync_runs")
        .update({ status: "failed", error_message: message, completed_at: new Date().toISOString() })
        .eq("id", run.id);
      await context.supabase
        .from("connected_platforms")
        .update({ last_sync_error: message })
        .eq("workspace_id", member.workspace_id)
        .eq("platform", "trustpilot");
      throw caught;
    }
  });
