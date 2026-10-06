import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/google-business/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        if (!state || !code || url.searchParams.get("error")) return new Response("Google authorization was cancelled or invalid.", { status: 400 });
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { decryptSecret, encryptSecret, exchangeGoogleCode, getGoogleAccountEmail, hashValue } = await import("@/lib/google-business.server");
        const { data: states, error } = await supabaseAdmin.rpc("claim_google_oauth_state", { _state_hash: hashValue(state) });
        const saved = states?.[0];
        if (error || !saved) return new Response("This Google authorization link expired. Start again from Settings.", { status: 400 });
        try {
          const storedVerifier = await decryptSecret(saved.code_verifier_ciphertext);
          let verifier = storedVerifier;
          let callbackOrigin = saved.redirect_origin;
          try {
            const stored = JSON.parse(storedVerifier) as { verifier?: unknown; callbackOrigin?: unknown };
            if (typeof stored.verifier === "string") verifier = stored.verifier;
            if (typeof stored.callbackOrigin === "string") callbackOrigin = stored.callbackOrigin;
          } catch {
            // Supports authorization attempts created before stable callbacks were introduced.
          }
          const { loadProviderCredentials } = await import("@/lib/integrations/credentials.server");
          const googleCreds = await loadProviderCredentials(supabaseAdmin, saved.workspace_id, "google_business");
          const tokens = await exchangeGoogleCode(code, verifier, `${callbackOrigin}/api/public/google-business/callback`, googleCreds);
          const { data: existing } = await supabaseAdmin.from("google_business_connections").select("refresh_token_ciphertext").eq("workspace_id", saved.workspace_id).maybeSingle();
          const refreshToken = tokens.refreshToken ? await encryptSecret(tokens.refreshToken) : existing?.refresh_token_ciphertext;
          if (!refreshToken) throw new Error("Google did not return offline access.");
          const email = await getGoogleAccountEmail(tokens.accessToken);
          const { error: saveError } = await supabaseAdmin.from("google_business_connections").upsert({
            workspace_id: saved.workspace_id,
            google_account_email: email,
            access_token_ciphertext: await encryptSecret(tokens.accessToken),
            refresh_token_ciphertext: refreshToken,
            token_expires_at: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
            scopes: tokens.scopes,
            status: "connected",
            last_error: null,
          }, { onConflict: "workspace_id" });
          if (saveError) throw saveError;
          await supabaseAdmin.from("connected_platforms").update({ status: "connected", account_ref: email, last_sync_error: null }).eq("workspace_id", saved.workspace_id).eq("platform", "google");
          return Response.redirect(`${saved.redirect_origin}/settings?google=connected`, 302);
        } catch {
          return Response.redirect(`${saved.redirect_origin}/settings?google=error`, 302);
        }
      },
    },
  },
});