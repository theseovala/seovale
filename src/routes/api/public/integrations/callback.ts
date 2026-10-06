import { createFileRoute } from "@tanstack/react-router";

// Shared OAuth callback for every third-party integration. Tokens are exchanged
// server-side, encrypted and stored; nothing sensitive is ever put in the redirect.
export const Route = createFileRoute("/api/public/integrations/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        const providerError = url.searchParams.get("error");
        if (!state) return new Response("Authorization response is missing its state value.", { status: 400 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { decryptValue, encryptValue, hashState } = await import("@/lib/integrations/crypto.server");
        const { data: states } = await supabaseAdmin.rpc("claim_integration_oauth_state", { _state_hash: hashState(state) });
        const saved = states?.[0];
        if (!saved) return new Response("This authorization link expired. Start again from Settings.", { status: 400 });

        const back = (status: string) =>
          Response.redirect(`${saved.redirect_origin}/settings?tab=integrations&integration=${saved.provider}&status=${status}`, 302);

        const log = (level: string, message: string, eventType: string, httpStatus: number | null = null) =>
          supabaseAdmin.from("integration_events").insert({
            workspace_id: saved.workspace_id,
            provider: saved.provider,
            event_type: eventType,
            level,
            message: message.slice(0, 500),
            http_status: httpStatus,
          });

        if (providerError || !code) {
          await log("error", `Provider rejected authorization: ${providerError ?? "no code returned"}`, "oauth_failed");
          return back("error");
        }

        try {
          const payload = JSON.parse(await decryptValue(saved.payload_ciphertext)) as {
            verifier: string | null;
            redirectUri: string;
          };
          const providers = await import("@/lib/integrations/providers.server");
          const { loadProviderCredentials } = await import("@/lib/integrations/credentials.server");
          const creds = await loadProviderCredentials(supabaseAdmin, saved.workspace_id, saved.provider);
          const tokens = await providers.exchangeCode(saved.provider, code, payload.verifier, payload.redirectUri, creds);

          let accessToken = tokens.accessToken;
          let expiresIn = tokens.expiresIn;
          if (saved.provider === "facebook" || saved.provider === "instagram") {
            const longLived = await providers.exchangeMetaLongLivedToken(accessToken, creds);
            if (longLived) {
              accessToken = longLived.accessToken;
              expiresIn = longLived.expiresIn;
            }
          }

          const config = providers.OAUTH_PROVIDERS[saved.provider];
          const test = config ? await config.test(accessToken) : { ok: false, status: 0, message: "Unknown integration.", label: null, accountRef: null };

          const { error } = await supabaseAdmin.from("integration_connections").upsert(
            {
              workspace_id: saved.workspace_id,
              provider: saved.provider,
              kind: "oauth2",
              status: test.ok ? "connected" : "error",
              account_label: test.label ?? null,
              account_ref: test.accountRef ?? null,
              scopes: tokens.scopes,
              access_token_ciphertext: await encryptValue(accessToken),
              refresh_token_ciphertext: tokens.refreshToken ? await encryptValue(tokens.refreshToken) : null,
              token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
              connected_by: saved.user_id,
              connected_at: new Date().toISOString(),
              last_tested_at: new Date().toISOString(),
              last_test_ok: test.ok,
              last_error: test.ok ? null : test.message,
            },
            { onConflict: "workspace_id,provider" },
          );
          if (error) throw error;

          await log(
            test.ok ? "info" : "error",
            test.ok ? "Authorized and verified with a live API call." : `Authorized but verification failed: ${test.message}`,
            test.ok ? "connected" : "verification_failed",
            test.status || null,
          );
          return back(test.ok ? "connected" : "error");
        } catch (caught) {
          await log("error", caught instanceof Error ? caught.message : "Authorization failed.", "oauth_failed");
          return back("error");
        }
      },
    },
  },
});
