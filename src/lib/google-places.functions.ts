import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SupabaseClient } from "@supabase/supabase-js";
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
  if (!apiKey) {
    throw new Error("Add a Google Places API key in the Google Maps / Places integration first.");
  }
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
    if (!integration?.account_ref) {
      throw new Error("Choose a business in Google Maps search before starting a scan.");
    }

    const { scanGooglePlace } = await import("@/lib/google-places.server");
    return scanGooglePlace(integration.account_ref, apiKey);
  });
