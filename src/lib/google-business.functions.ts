import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function workspace(context: { supabase: any; userId: string }) {
  const { data, error } = await context.supabase.from("workspace_members").select("workspace_id, role").eq("user_id", context.userId).order("created_at").limit(1).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("No workspace is assigned to this account.");
  return data as { workspace_id: string; role: "owner" | "admin" | "member" };
}

export const getGoogleBusinessConnection = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const member = await workspace(context);
    // Token ciphertext is owner/admin-only at the database level, so this status read
    // runs server-side after membership has already been verified above.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin.from("google_business_connections").select("google_account_email,status,last_synced_at,last_error").eq("workspace_id", member.workspace_id).maybeSingle();
    if (error) throw error;
    return {
      configured: Boolean(process.env["GOOGLE_BUSINESS_CLIENT_ID"] && process.env["GOOGLE_BUSINESS_CLIENT_SECRET"]),
      connected: data?.status === "connected",
      email: data?.google_account_email ?? null,
      status: data?.status ?? null,
      lastSyncedAt: data?.last_synced_at ?? null,
      lastError: data?.last_error ?? null,
    };
  });

export const startGoogleBusinessConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ origin: z.string().url() }).parse(input))
  .handler(async ({ data, context }) => {
    const member = await workspace(context);
    if (member.role === "member") throw new Error("Only a workspace owner or admin can connect Google.");
    const { assertAllowedOrigin, createGoogleAuthorization, encryptSecret, googleCallbackOrigin, hashValue } = await import("./google-business.server");
    const origin = assertAllowedOrigin(data.origin);
    const callbackOrigin = googleCallbackOrigin(origin);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { loadProviderCredentials } = await import("./integrations/credentials.server");
    const googleCreds = await loadProviderCredentials(supabaseAdmin, member.workspace_id, "google_business");
    const auth = createGoogleAuthorization(`${callbackOrigin}/api/public/google-business/callback`, googleCreds);
    const { error } = await context.supabase.from("google_oauth_states").insert({
      workspace_id: member.workspace_id,
      user_id: context.userId,
      state_hash: hashValue(auth.state),
      code_verifier_ciphertext: await encryptSecret(JSON.stringify({ verifier: auth.verifier, callbackOrigin })),
      redirect_origin: origin,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    if (error) throw error;
    return { authorizationUrl: auth.url };
  });

export const syncGoogleBusinessReviews = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const member = await workspace(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: connection, error } = await supabaseAdmin.from("google_business_connections").select("access_token_ciphertext,refresh_token_ciphertext,token_expires_at,status").eq("workspace_id", member.workspace_id).maybeSingle();
    if (error) throw error;
    if (!connection || connection.status !== "connected") throw new Error("Connect Google Business Profile first.");
    const { fetchGoogleReviews, usableAccessToken } = await import("./google-business-sync.server");
    const { data: run, error: runError } = await context.supabase.from("sync_runs").insert({ workspace_id: member.workspace_id, platform: "google" }).select("id").single();
    if (runError) throw runError;
    try {
      const token = await usableAccessToken(supabaseAdmin, member.workspace_id, connection);
      const batches = await fetchGoogleReviews(token);
      const { data: rules } = await context.supabase.from("alert_rules").select("negative_rating_threshold").eq("workspace_id", member.workspace_id).maybeSingle();
      // A report the platform will act on has to point at the review. Google
      // publishes no per-review permalink, so this returns the place link when a
      // real place id came back and null otherwise — never a guessed URL.
      const { deriveReviewUrl } = await import("@/lib/removal/review-url");
      let found = 0;
      let created = 0;
      let updated = 0;
      let alerts = 0;
      for (const batch of batches) {
        const { data: existingLocation } = await context.supabase.from("locations").select("id").eq("workspace_id", member.workspace_id).eq("external_ref", batch.location.externalRef).maybeSingle();
        if (existingLocation) {
          await context.supabase.from("locations").update({ name: batch.location.name, city: batch.location.city, country: batch.location.country }).eq("id", existingLocation.id);
        } else {
          const { error: locationError } = await context.supabase.from("locations").insert({ workspace_id: member.workspace_id, external_ref: batch.location.externalRef, name: batch.location.name, city: batch.location.city, country: batch.location.country });
          if (locationError) throw locationError;
        }
        const reviewUrl = deriveReviewUrl({ platform: "google", placeId: batch.location.placeId }).url;
        for (const review of batch.reviews) {
          found += 1;
          const sentiment = review.rating >= 4 ? "positive" : review.rating === 3 ? "neutral" : "negative";
          const priority = review.rating <= 2 ? "high" : review.rating === 3 ? "medium" : "low";
          const { data: existing } = await context.supabase.from("reviews").select("id").eq("workspace_id", member.workspace_id).eq("platform", "google").eq("external_id", review.id).maybeSingle();
          let storedReviewId: string;
          if (existing) {
            const { error: updateError } = await context.supabase.from("reviews").update({ author: review.author, rating: review.rating, body: review.body, sentiment, priority, location_name: batch.location.name, external_created_at: review.createdAt, review_url: reviewUrl as never }).eq("id", existing.id);
            if (updateError) throw updateError;
            storedReviewId = existing.id;
            updated += 1;
          } else {
            const { data: inserted, error: insertError } = await context.supabase.from("reviews").insert({ workspace_id: member.workspace_id, platform: "google", external_id: review.id, source: "google_business", author: review.author, rating: review.rating, sentiment, status: "pending", priority, location_name: batch.location.name, body: review.body, external_created_at: review.createdAt, review_url: reviewUrl as never }).select("id").single();
            if (insertError) throw insertError;
            storedReviewId = inserted.id;
            created += 1;
          }
          if (review.rating <= (rules?.negative_rating_threshold ?? 2)) {
            const { data: existingAlert, error: alertLookupError } = await context.supabase
              .from("alerts")
              .select("id")
              .eq("workspace_id", member.workspace_id)
              .eq("review_id", storedReviewId)
              .eq("kind", "negative_review")
              .limit(1)
              .maybeSingle();
            if (alertLookupError) throw alertLookupError;
            if (!existingAlert) {
              const { error: alertError } = await context.supabase.from("alerts").insert({ workspace_id: member.workspace_id, review_id: storedReviewId, kind: "negative_review", severity: review.rating === 1 ? "critical" : "high", title: `${review.rating}-star Google review`, detail: review.body.slice(0, 240), location_name: batch.location.name });
              if (alertError) throw alertError;
              alerts += 1;
            }
          }
        }
      }
      const now = new Date().toISOString();
      await context.supabase.from("sync_runs").update({ status: "completed", locations_found: batches.length, reviews_found: found, reviews_created: created, reviews_updated: updated, alerts_created: alerts, completed_at: now }).eq("id", run.id);
      await supabaseAdmin.from("google_business_connections").update({ last_synced_at: now, last_error: null }).eq("workspace_id", member.workspace_id);
      await context.supabase.from("connected_platforms").update({ status: "connected", last_synced_at: now, last_sync_error: null }).eq("workspace_id", member.workspace_id).eq("platform", "google");
      return { locations: batches.length, reviewsFound: found, reviewsCreated: created, reviewsUpdated: updated, alertsCreated: alerts };
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Google sync failed";
      await context.supabase.from("sync_runs").update({ status: "failed", error_message: message, completed_at: new Date().toISOString() }).eq("id", run.id);
      await supabaseAdmin.from("google_business_connections").update({ last_error: message }).eq("workspace_id", member.workspace_id);
      throw caught;
    }
  });

export const disconnectGoogleBusiness = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const member = await workspace(context);
    if (member.role === "member") throw new Error("Only a workspace owner or admin can disconnect Google.");
    const { error } = await context.supabase.from("google_business_connections").delete().eq("workspace_id", member.workspace_id);
    if (error) throw error;
    await context.supabase.from("connected_platforms").update({ status: "disconnected", account_ref: null }).eq("workspace_id", member.workspace_id).eq("platform", "google");
    return { disconnected: true };
  });