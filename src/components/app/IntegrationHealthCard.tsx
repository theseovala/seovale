import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Activity, AlertTriangle, ChevronDown, ChevronRight, Gauge, RefreshCw } from "lucide-react";
import { Section, EmptyState } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { relativeTime } from "@/lib/seovale-db";
import { getIntegrationHealth, getIntegrationHealthDetail } from "@/lib/integrations.functions";

const HEALTH_DOT: Record<string, string> = {
  healthy: "bg-emerald-500",
  unhealthy: "bg-red-500",
};

function healthDot(status: string | null) {
  if (!status) return "bg-muted-foreground/40";
  return HEALTH_DOT[status] ?? "bg-amber-500";
}

function ProviderDetail({ provider }: { provider: string }) {
  const detailFn = useServerFn(getIntegrationHealthDetail);
  const detail = useQuery({
    queryKey: ["integration-health-detail", provider],
    queryFn: () => detailFn({ data: { provider } }),
  });

  if (detail.isLoading) {
    return (
      <div className="grid gap-3 px-4 py-3 sm:grid-cols-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (detail.isError || !detail.data) {
    return (
      <p className="px-4 py-3 text-xs text-destructive">
        {(detail.error as Error)?.message ?? "Could not load details."}
      </p>
    );
  }
  const d = detail.data;
  return (
    <div className="grid gap-4 border-t bg-muted/30 px-4 py-3 sm:grid-cols-3">
      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Recent syncs
        </p>
        {d.syncJobs.length === 0 ? (
          <p className="text-xs text-muted-foreground">No sync jobs recorded yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {d.syncJobs.map((job, i) => (
              <li key={i} className="text-xs">
                <span className="font-medium">{job.jobType}</span>{" "}
                <span
                  className={job.status === "failed" ? "text-destructive" : "text-muted-foreground"}
                >
                  · {job.status}
                </span>
                <span className="block text-muted-foreground">
                  {job.completedAt
                    ? `finished ${relativeTime(job.completedAt)}`
                    : job.startedAt
                      ? `started ${relativeTime(job.startedAt)}`
                      : "not started"}
                  {job.attempts > 1 ? ` · ${job.attempts} attempts` : ""}
                </span>
                {job.lastError ? (
                  <span className="block truncate text-destructive">{job.lastError}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Rate limit history
        </p>
        {d.rateLimits.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Provider API has not reported rate limits.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {d.rateLimits.map((r, i) => (
              <li key={i} className="text-xs">
                <span className="inline-flex items-center gap-1 font-medium">
                  <Gauge className="size-3" />
                  {r.remaining ?? "?"}/{r.limit ?? "?"} left
                </span>
                <span className="block text-muted-foreground">
                  {r.resetAt ? `resets ${relativeTime(r.resetAt)} · ` : ""}recorded{" "}
                  {relativeTime(r.recordedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Error log (24h) · {d.calls24h} calls
        </p>
        {d.errors.length === 0 ? (
          <p className="text-xs text-muted-foreground">No errors in the last 24 hours.</p>
        ) : (
          <ul className="max-h-40 space-y-1.5 overflow-y-auto pr-1">
            {d.errors.map((e, i) => (
              <li key={i} className="text-xs">
                <span className="inline-flex items-center gap-1 font-medium text-destructive">
                  <AlertTriangle className="size-3" />
                  {e.httpStatus ? `${e.httpStatus} · ` : ""}
                  {e.outcomeCode ?? e.operation}
                </span>
                <span className="block break-words text-muted-foreground">{e.message}</span>
                <span className="block text-muted-foreground/70">{relativeTime(e.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Real-time per-provider health with expandable detail: last syncs, rate limits and 24h error log. Refreshes every 30 seconds. */
export function IntegrationHealthCard() {
  const healthFn = useServerFn(getIntegrationHealth);
  const health = useQuery({
    queryKey: ["integration-health"],
    queryFn: () => healthFn(),
    refetchInterval: 30_000,
  });
  const [expanded, setExpanded] = useState<string | null>(null);

  const items = (health.data?.items ?? []).filter(
    (item) => item.status || item.lastSyncAt || item.rateLimit || item.errors24h > 0,
  );
  const unhealthy = items.filter((i) => i.status === "unhealthy").length;
  const totalErrors = items.reduce((sum, i) => sum + i.errors24h, 0);

  return (
    <Section
      className="mb-6"
      title="Integration health"
      description={
        health.isLoading
          ? "Reading live provider telemetry…"
          : `${items.length} providers with activity · ${unhealthy} unhealthy · ${totalErrors} errors in 24h · refreshes every 30s`
      }
      action={
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => health.refetch()}
            disabled={health.isFetching}
          >
            <RefreshCw className={health.isFetching ? "animate-spin" : ""} /> Refresh
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/settings" search={{ tab: "integrations" }}>
              Manage <ChevronRight />
            </Link>
          </Button>
        </div>
      }
    >
      {health.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : health.isError ? (
        <EmptyState
          icon={Activity}
          title="Health unavailable"
          description={(health.error as Error).message}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="No provider activity yet"
          description="Connect a provider in the Integration Manager and run a test — its real health, sync time, rate limit and errors will appear here."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="w-6 py-2" />
                <th className="py-2 pr-3 font-semibold">Provider</th>
                <th className="py-2 pr-3 font-semibold">Status</th>
                <th className="py-2 pr-3 font-semibold">Last sync</th>
                <th className="py-2 pr-3 font-semibold">Rate limit</th>
                <th className="py-2 pr-3 font-semibold">Errors (24h)</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const isOpen = expanded === item.provider;
                return [
                  <tr
                    key={item.provider}
                    className="cursor-pointer border-b transition-colors hover:bg-accent/40"
                    onClick={() => setExpanded(isOpen ? null : item.provider)}
                    aria-expanded={isOpen}
                  >
                    <td className="py-2.5 pl-1">
                      <ChevronDown
                        className={`size-3.5 text-muted-foreground transition-transform ${isOpen ? "" : "-rotate-90"}`}
                      />
                    </td>
                    <td className="py-2.5 pr-3 font-medium">{item.label}</td>
                    <td className="py-2.5 pr-3">
                      <span className="inline-flex items-center gap-1.5 text-xs">
                        <span className={`size-2 rounded-full ${healthDot(item.status)}`} />
                        {item.status
                          ? item.status === "healthy"
                            ? "Healthy"
                            : (item.outcomeCode ?? "Unhealthy")
                          : "Not tested"}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-muted-foreground">
                      {item.lastSyncAt ? relativeTime(item.lastSyncAt) : "Never synced"}
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-muted-foreground">
                      {item.rateLimit ? (
                        <span className="inline-flex items-center gap-1">
                          <Gauge className="size-3" />
                          {item.rateLimit.remaining ?? "?"}/{item.rateLimit.limit ?? "?"} left
                        </span>
                      ) : (
                        "Not provided by API"
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-xs">
                      {item.errors24h > 0 ? (
                        <span
                          className="inline-flex items-center gap-1 font-semibold text-destructive"
                          title={item.lastError ?? undefined}
                        >
                          <AlertTriangle className="size-3" />
                          {item.errors24h}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </td>
                  </tr>,
                  isOpen ? (
                    <tr key={`${item.provider}-detail`} className="border-b">
                      <td colSpan={6} className="p-0">
                        <ProviderDetail provider={item.provider} />
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
