import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function googlePlacesContext(
  context: { supabase: SupabaseClient; userId: string },
  operation: "scan" | "search",
) {
  const { data: member, error: membershipError } = await context.supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", context.userId)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (membershipError) throw membershipError;
  if (!member) throw new Error("No workspace is assigned to this account.");

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { rateLimit } = await import("@/lib/license/authority.server");
  const budget = await rateLimit(
    supabaseAdmin,
    `google_places_${operation}`,
    member.workspace_id,
    operation === "scan" ? 30 : 20,
    3600,
  );
  if (budget.error) {
    throw new Error(`Google Places request limit could not be verified: ${budget.error}`);
  }
  if (!budget.allowed) {
    throw new Error(
      `Too many Google Places ${operation}s were started. Try again in ${Math.ceil(budget.retryAfterSeconds / 60)} minutes.`,
    );
  }

  const { loadProviderCredentials } = await import("@/lib/integrations/credentials.server");
  const { envValue } = await import("@/lib/integrations/providers.server");
  const credentials = await loadProviderCredentials(
    supabaseAdmin,
    member.workspace_id,
    "google_maps",
  );
  const apiKey = envValue(["GOOGLE_MAPS_API_KEY"], credentials);
  if (!apiKey)
    throw new Error("Add a Google Places API key in the Google Maps / Places integration first.");
  return { member, supabaseAdmin, apiKey };
}

export const searchGooglePlacesForWorkspace = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ query: z.string().trim().min(3).max(200) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { apiKey } = await googlePlacesContext(context, "search");
    const { searchGooglePlaces } = await import("@/lib/google-places.server");
    return searchGooglePlaces(data.query, apiKey);
  });

export const scanGooglePlacesReviews = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { member, supabaseAdmin, apiKey } = await googlePlacesContext(context, "scan");
    const { data: integration, error: integrationError } = await supabaseAdmin
      .from("integration_connections")
      .select("account_ref")
      .eq("workspace_id", member.workspace_id)
      .eq("provider", "google_maps")
      .maybeSingle();
    if (integrationError) throw integrationError;
    if (!integration?.account_ref)
      throw new Error("Choose your business in Google Maps search before starting a scan.");

    const { scanGooglePlace } = await import("@/lib/google-places.server");
    return scanGooglePlace(integration.account_ref, apiKey);
  });

export const resolveGoogleMapsUrlForWorkspace = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ url: z.string().trim().min(1).max(2048) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { apiKey } = await googlePlacesContext(context, "search");
    const { resolveGoogleMapsUrl } = await import("@/lib/google-places.server");
    return resolveGoogleMapsUrl(data.url, apiKey);
  });

export const scanGooglePlaceIdForWorkspace = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ placeId: z.string().trim().min(1).max(256) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { apiKey } = await googlePlacesContext(context, "scan");
    const { scanGooglePlace } = await import("@/lib/google-places.server");
    return scanGooglePlace(data.placeId, apiKey);
  });
