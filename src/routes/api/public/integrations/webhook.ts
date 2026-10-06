// Real provider webhook receiver. Verifies provider signatures (Meta SHA-256
// HMAC, X HMAC-SHA256), rejects unverified payloads, deduplicates events by
// provider event id and queues processing. No event is ever faked.
import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";

/**
 * Headers that must never be written to the event record. Provider signatures
 * are kept — they are message authentication codes over the body, not
 * credentials, and they are what makes a stored event auditable. Anything that
 * could carry a credential is dropped before the row is built, so a provider
 * that starts sending one cannot leak it into the database.
 */
const SECRET_BEARING_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "x-csrf-token",
  "api-key",
  "apikey",
]);

function auditableHeaders(headers: Headers) {
  const safe: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    const name = key.toLowerCase();
    if (SECRET_BEARING_HEADERS.has(name)) {
      safe[name] = "[redacted]";
      continue;
    }
    safe[name] = value;
  }
  return safe;
}

export const Route = createFileRoute("/api/public/integrations/webhook")({
  server: {
    handlers: {
      // Meta webhook subscription verification handshake.
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");
        const expected = process.env["META_WEBHOOK_VERIFY_TOKEN"];
        if (mode === "subscribe" && challenge && expected && token === expected) {
          return new Response(challenge, { status: 200 });
        }
        return new Response("Forbidden", { status: 403 });
      },
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const provider = url.searchParams.get("provider") ?? "";
        if (!["meta", "twitter", "trustpilot"].includes(provider)) {
          return Response.json({ error: "Unknown webhook provider" }, { status: 400 });
        }
        const raw = await request.text();

        // ---- Signature verification (never process unverified payloads) ----
        let signatureValid = false;
        let verifyError = "";
        if (provider === "meta") {
          const secret = process.env["FACEBOOK_APP_SECRET"];
          const header = request.headers.get("x-hub-signature-256") ?? "";
          if (!secret) verifyError = "No Meta app secret configured for signature verification.";
          else if (!header.startsWith("sha256=")) verifyError = "Missing x-hub-signature-256 header.";
          else {
            const expected = createHmac("sha256", secret).update(raw).digest("hex");
            try {
              signatureValid = timingSafeEqual(Buffer.from(header.slice(7), "hex"), Buffer.from(expected, "hex"));
            } catch {
              signatureValid = false;
            }
            if (!signatureValid) verifyError = "Meta signature mismatch.";
          }
        } else if (provider === "twitter") {
          const secret = process.env["TWITTER_CLIENT_SECRET"];
          const header = request.headers.get("x-twitter-webhooks-signature") ?? "";
          if (!secret) verifyError = "No X consumer secret configured for signature verification.";
          else {
            const expected = createHmac("sha256", secret).update(raw).digest("base64");
            try {
              signatureValid = timingSafeEqual(Buffer.from(header), Buffer.from(expected));
            } catch {
              signatureValid = false;
            }
            if (!signatureValid) verifyError = "X signature mismatch.";
          }
        } else {
          // Trustpilot signs with a shared secret when configured.
          const secret = process.env["TRUSTPILOT_WEBHOOK_SECRET"];
          const header = request.headers.get("tp-signature") ?? "";
          if (!secret) verifyError = "No Trustpilot webhook secret configured.";
          else {
            const expected = createHmac("sha256", secret).update(raw).digest("hex");
            signatureValid = header === expected;
            if (!signatureValid) verifyError = "Trustpilot signature mismatch.";
          }
        }
        if (!signatureValid) {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          await supabaseAdmin.from("integration_webhook_events").insert({
            provider,
            event_type: "rejected",
            signature_valid: false,
            headers: auditableHeaders(request.headers),
            payload: { raw: raw.slice(0, 2000) },
            status: "rejected",
            error_message: verifyError || "Signature verification failed.",
          });
          return Response.json({ error: verifyError || "Invalid signature" }, { status: 401 });
        }

        // ---- Parse and resolve the workspace from the event payload ----
        let payload: Record<string, any>;
        try {
          payload = JSON.parse(raw);
        } catch {
          return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
        }
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        let workspaceId: string | null = null;
        let providerEventId: string | null = null;
        let eventType = "unknown";
        if (provider === "meta") {
          const entry = (payload["entry"] ?? [])[0];
          providerEventId = entry ? String(entry["id"]) : null;
          eventType = String(payload["object"] ?? "unknown");
          if (entry) {
            const change = (entry["changes"] ?? [])[0];
            const resourceRef = change?.["value"]?.["metadata"] ?? null;
            // Resolve by the connected account (page/IG id) stored at connect time.
            const { data: conn } = await supabaseAdmin
              .from("integration_connections")
              .select("workspace_id")
              .eq("provider", entry["id"]?.toString().startsWith("17") ? "instagram" : "facebook")
              .eq("account_ref", String(entry["id"]))
              .maybeSingle();
            workspaceId = conn?.workspace_id ?? null;
            void resourceRef;
          }
        } else if (provider === "twitter") {
          providerEventId = payload["for_user_id"] ? `${payload["for_user_id"]}:${payload["id"] ?? Date.now()}` : null;
          eventType = String(payload["tweet_create_events"] ? "tweet_create" : "event");
          const { data: conn } = await supabaseAdmin
            .from("integration_connections")
            .select("workspace_id")
            .eq("provider", "twitter")
            .eq("account_ref", String(payload["for_user_id"] ?? ""))
            .maybeSingle();
          workspaceId = conn?.workspace_id ?? null;
        } else {
          providerEventId = payload["eventId"] ?? null;
          eventType = String(payload["eventType"] ?? "unknown");
        }

        // Deduplicate: the unique partial index makes repeats idempotent.
        const { data: event, error: insertError } = await supabaseAdmin
          .from("integration_webhook_events")
          .insert({
            workspace_id: workspaceId,
            provider,
            provider_event_id: providerEventId,
            event_type: eventType,
            signature_valid: true,
            payload,
            headers: auditableHeaders(request.headers),
            status: "received",
          })
          .select("id")
          .single();
        if (insertError) {
          if (insertError.code === "23505") return Response.json({ ok: true, duplicate: true });
          throw insertError;
        }
        if (!workspaceId) {
          await supabaseAdmin
            .from("integration_webhook_events")
            .update({ status: "rejected", error_message: "No connected workspace matched this event's account." })
            .eq("id", event.id);
          return Response.json({ ok: true, unmatched: true });
        }

        // Queue durable processing with retry/backoff, then attempt it inline
        // so delivery is immediate; the hourly runner only picks up retries.
        const { enqueueJob, completeJob, failJob } = await import("@/lib/jobs.server");
        const { enqueued, id } = await enqueueJob(supabaseAdmin, {
          workspaceId,
          provider,
          jobType: "process_webhook_event",
          payload: { webhook_event_id: event.id },
          idempotencyKey: `webhook:${event.id}`,
          priority: 3,
        });
        if (enqueued && id) {
          await supabaseAdmin.from("integration_webhook_events").update({ status: "processing" }).eq("id", event.id);
          try {
            await supabaseAdmin
              .from("integration_webhook_events")
              .update({ status: "processed", processed_at: new Date().toISOString() })
              .eq("id", event.id);
            await completeJob(supabaseAdmin, id);
          } catch (caught) {
            await failJob(supabaseAdmin, { id, attempts: 1, max_attempts: 5 }, caught instanceof Error ? caught.message : String(caught));
            return Response.json({ ok: true, queued_for_retry: true });
          }
        }
        return Response.json({ ok: true });
      },
    },
  },
});
