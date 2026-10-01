import { createFileRoute } from "@tanstack/react-router";
import { handleIntegrationCallback } from "../integrations/callback";

export const Route = createFileRoute("/api/public/youtube/callback")({
  server: {
    handlers: {
      GET: ({ request }) => handleIntegrationCallback(request),
    },
  },
});
