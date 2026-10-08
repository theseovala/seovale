import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronRight, Plug } from "lucide-react";
import { Section, EmptyState } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { relativeTime } from "@/lib/seovale-db";
import { INTEGRATIONS } from "@/lib/integrations/registry";
import { integrationStatusLabel, integrationStatusTone } from "@/lib/integrations/status";
import { listIntegrations } from "@/lib/integrations.functions";

/** Live connection status for every third-party account, read from verified test results. */
export function IntegrationStatusStrip() {
  const listFn = useServerFn(listIntegrations);
  const integrations = useQuery({ queryKey: ["integrations"], queryFn: () => listFn() });

  const items = integrations.data?.items ?? [];
  const byId = new Map(items.map((item) => [item.provider, item]));
  const connected = items.filter((i) => i.status === "connected").length;
  const problems = items.filter((i) => i.status === "error" || i.status === "expired").length;

  return (
    <Section
      className="mb-6"
      title="Integration status"
      description={
        integrations.isLoading
          ? "Checking stored connection results…"
          : `${connected} connected · ${problems} needing attention · verified by live API tests`
      }
      action={
        <Button variant="ghost" size="sm" asChild>
          <Link to="/settings" search={{ tab: "integrations" }}>
            Integration manager <ChevronRight />
          </Link>
        </Button>
      }
    >
      {integrations.isLoading ? (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {INTEGRATIONS.slice(0, 6).map((definition) => (
            <Skeleton key={definition.id} className="h-14 w-full" />
          ))}
        </div>
      ) : integrations.isError ? (
        <EmptyState
          icon={Plug}
          title="Status unavailable"
          description={(integrations.error as Error).message}
        />
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {INTEGRATIONS.map((definition) => {
            const item = byId.get(definition.id);
            const status = item?.status ?? "disconnected";
            return (
              <li
                key={definition.id}
                className="flex items-center gap-3 rounded-lg border bg-card/60 px-3 py-2.5 transition-colors hover:bg-accent/40"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{definition.label}</p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {item?.lastTestedAt
                      ? `Last checked ${relativeTime(item.lastTestedAt)}`
                      : status === "unavailable"
                        ? "No public API available"
                        : "Never tested"}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${integrationStatusTone[status]}`}
                >
                  {integrationStatusLabel[status] ?? status}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
