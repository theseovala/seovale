import { createFileRoute } from "@tanstack/react-router";
import { handleIntegrationCallback } from "@/lib/integrations/callback.server";

export const Route = createFileRoute("/api/public/youtube/callback")({
  server: {
    handlers: {
      GET: ({ request }) => handleIntegrationCallback(request),
    },
  },
});
