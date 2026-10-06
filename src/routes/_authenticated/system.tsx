import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, RefreshCw, ShieldAlert, Loader2, Play, Pause, Ban, Trash2, Eye } from "lucide-react";
import { AppShell } from "@/components/app/AppShell";
import { PageHeader, Section, EmptyState } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { getSystemHealth, listScanMonitor, getObservability, getScanTrace } from "@/lib/ops.functions";
import { runScanNow, pauseScan, resumeScan, cancelScan, deleteScan, createScan } from "@/lib/scan.functions";

export const Route = createFileRoute("/_authenticated/system")({
  head: () => ({
    meta: [
      { title: "System Health & Observability — Seovale" },
      {
        name: "description",
        content:
          "Live health of the database, scan engine, queue, workers, AI, crawler and every connected platform, with scan traces, errors, security events and audit history.",
      },
      { property: "og:title", content: "System Health & Observability — Seovale" },
      { property: "og:description", content: "Real health checks, scan monitoring, queue state, provider health and error tracing." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SystemPage,
});

const HEALTH_TONE: Record<string, string> = {
  healthy: "bg-positive-soft text-positive",
  degraded: "bg-warning-soft text-rating-foreground",
  failed: "bg-negative-soft text-negative",
  not_configured: "bg-neutral-soft text-muted-foreground",
};
const HEALTH_LABEL: Record<string, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  failed: "Failed",
  not_configured: "Not configured",
};

function when(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : "—";
}

function SystemPage() {
  const queryClient = useQueryClient();
  const [traceId, setTraceId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const health = useQuery({ queryKey: ["system-health"], queryFn: () => getSystemHealth(), refetchInterval: 60_000 });
  const monitor = useQuery({ queryKey: ["scan-monitor"], queryFn: () => listScanMonitor(), refetchInterval: 20_000 });
  const obs = useQuery({ queryKey: ["observability"], queryFn: () => getObservability(), refetchInterval: 60_000 });
  const trace = useQuery({
    queryKey: ["scan-trace", traceId],
    queryFn: () => getScanTrace({ data: { id: traceId as string } }),
    enabled: Boolean(traceId),
  });

  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: ["system-health"] });
    queryClient.invalidateQueries({ queryKey: ["scan-monitor"] });
    queryClient.invalidateQueries({ queryKey: ["observability"] });
  };

  const act = useMutation({
    mutationFn: async ({ action, id, url }: { action: string; id: string; url?: string }) => {
      if (action === "retry") return runScanNow({ data: { id } });
      if (action === "resume") return resumeScan({ data: { id } });
      if (action === "pause") return pauseScan({ data: { id } });
      if (action === "cancel") return cancelScan({ data: { id } });
      if (action === "delete") return deleteScan({ data: { id } });
      if (action === "rerun") {
        const created = await createScan({ data: { url: url as string } });
        return runScanNow({ data: { id: created.id } });
      }
      throw new Error("Unknown action");
    },
    onSuccess: (_result, variables) => {
      toast.success(`Scan ${variables.action} finished.`);
      setConfirmDelete(null);
      refreshAll();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const loading = health.isLoading || monitor.isLoading || obs.isLoading;

  return (
    <AppShell>
      <PageHeader
        title="System health & observability"
        description="Every status on this page comes from a live check or a stored operational record. Nothing is marked healthy without a real result."
        actions={
          <Button variant="outline" onClick={refreshAll} disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Re-run checks
          </Button>
        }
      />

      <Section title="Master system health" description="Checked live each time this page loads.">
        {health.isLoading ? (
          <p className="text-sm text-muted-foreground">Running real checks…</p>
        ) : health.error ? (
          <p className="text-sm text-negative">{(health.error as Error).message}</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {health.data?.components.map((item) => (
                <div key={item.component} className="card-interactive rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{item.component}</span>
                    <Badge variant="outline" className={cn("h-5 px-1.5 text-[10px] uppercase", HEALTH_TONE[item.status])}>
                      {HEALTH_LABEL[item.status]}
                    </Badge>
                  </div>
                  <p className="mt-1 break-words text-xs text-muted-foreground">{item.detail}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {item.latencyMs !== null ? `${item.latencyMs}ms · ` : ""}checked {when(item.checkedAt)}
                  </p>
                </div>
              ))}
            </div>
            {(health.data?.recovered.scans ?? 0) + (health.data?.recovered.jobs ?? 0) > 0 ? (
              <p className="mt-3 text-xs text-rating-foreground">
                Stalled work recovered on this check: {health.data?.recovered.scans} scans, {health.data?.recovered.jobs} jobs.
              </p>
            ) : null}
          </>
        )}
      </Section>

      <Section title="Scan monitoring" description="The last 25 scans with their real stage, sources, AI and output state.">
        {monitor.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (monitor.data?.scans.length ?? 0) === 0 ? (
          <EmptyState icon={Activity} title="No scans yet" description="Start a scan to see its live progress and trace here." />
        ) : (
          <ul className="space-y-2">
            {monitor.data?.scans.map((scan: any) => (
              <li key={scan.id} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{scan.target_domain}</span>
                  <Badge variant="outline" className="h-5 px-1.5 text-[10px] uppercase">
                    {scan.status.replace(/_/g, " ")}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    started {when(scan.started_at ?? scan.created_at)} · {scan.duration_ms ? `${Math.round(scan.duration_ms / 1000)}s` : "running"} · attempt {scan.attempts}/{scan.max_attempts}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Stage: {scan.currentStage} ({scan.progress}%) · Sources used {scan.providersUsed} · succeeded {scan.successfulSources.length} · failed {scan.failedSources.length} · not available {scan.skippedSources.length} · AI {scan.aiStatus} · report {scan.reportStatus} · CSV {scan.csvStatus}
                </p>
                {scan.error_message ? <p className="mt-1 break-words text-xs text-rating-foreground">{scan.error_message}</p> : null}
                {scan.skippedSources.length ? (
                  <p className="mt-1 break-words text-[11px] text-muted-foreground">
                    Not available: {scan.skippedSources.map((s: any) => `${s.source} (${s.status.replace(/_/g, " ")})`).join(", ")}
                  </p>
                ) : null}
                {scan.failedSources.length ? (
                  <p className="mt-1 break-words text-[11px] text-muted-foreground">
                    Failed sources: {scan.failedSources.map((s: any) => `${s.source} (${s.status}${s.httpStatus ? ` ${s.httpStatus}` : ""})`).join(", ")}
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => setTraceId(traceId === scan.id ? null : scan.id)}>
                    <Eye className="mr-1 h-3.5 w-3.5" /> {traceId === scan.id ? "Hide trace" : "View trace"}
                  </Button>
                  <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ action: "retry", id: scan.id })}>
                    <RefreshCw className="mr-1 h-3.5 w-3.5" /> Retry
                  </Button>
                  <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ action: "resume", id: scan.id })}>
                    <Play className="mr-1 h-3.5 w-3.5" /> Resume
                  </Button>
                  <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ action: "pause", id: scan.id })}>
                    <Pause className="mr-1 h-3.5 w-3.5" /> Pause
                  </Button>
                  <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ action: "cancel", id: scan.id })}>
                    <Ban className="mr-1 h-3.5 w-3.5" /> Cancel
                  </Button>
                  <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ action: "rerun", id: scan.id, url: scan.target_url })}>
                    Re-run
                  </Button>
                  {confirmDelete === scan.id ? (
                    <>
                      <Button size="sm" variant="destructive" disabled={act.isPending} onClick={() => act.mutate({ action: "delete", id: scan.id })}>
                        Confirm delete
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
                        Keep
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(scan.id)}>
                      <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
                    </Button>
                  )}
                </div>
                {traceId === scan.id ? (
                  <div className="mt-3 rounded-md border border-border bg-muted/20 p-3 text-xs">
                    {trace.isLoading ? (
                      <p className="text-muted-foreground">Loading trace…</p>
                    ) : trace.error ? (
                      <p className="text-negative">{(trace.error as Error).message}</p>
                    ) : (
                      <div className="space-y-2">
                        <p className="font-medium">Timeline</p>
                        {trace.data?.stages.map((stage: any) => (
                          <p key={stage.stage} className="text-muted-foreground">
                            {stage.position}. {stage.label} — {stage.status}
                            {stage.detail ? ` · ${stage.detail}` : ""} · {when(stage.started_at)} → {when(stage.completed_at)}
                          </p>
                        ))}
                        <p className="pt-1 font-medium">Provider calls</p>
                        {trace.data?.sources.length === 0 ? (
                          <p className="text-muted-foreground">No provider call was recorded.</p>
                        ) : (
                          trace.data?.sources.map((source: any, index: number) => (
                            <p key={`${source.source}-${index}`} className="break-words text-muted-foreground">
                              {source.source}
                              {source.provider ? ` (${source.provider})` : ""} — {source.status}
                              {source.http_status ? ` · HTTP ${source.http_status}` : ""}
                              {source.duration_ms ? ` · ${source.duration_ms}ms` : ""}
                              {source.error_message ? ` · ${source.error_message}` : ""}
                            </p>
                          ))
                        )}
                        <p className="pt-1 font-medium">AI & report</p>
                        <p className="text-muted-foreground">
                          Report AI: {trace.data?.report?.ai_status ?? "not generated"}
                          {trace.data?.report?.model ? ` · ${trace.data.report.model}` : ""}
                          {trace.data?.report?.ai_latency_ms ? ` · ${trace.data.report.ai_latency_ms}ms` : ""}
                          {trace.data?.report?.ai_error ? ` · ${trace.data.report.ai_error}` : ""}
                        </p>
                        <p className="text-muted-foreground">
                          {trace.data?.findingCount} findings · {trace.data?.evidenceCount} evidence records stored.
                        </p>
                        {(trace.data?.security.length ?? 0) > 0 ? (
                          <>
                            <p className="pt-1 font-medium">Security events for this scan</p>
                            {trace.data?.security.map((event: any, index: number) => (
                              <p key={index} className="text-rating-foreground">
                                {event.event_type}: {event.message} · {when(event.created_at)}
                              </p>
                            ))}
                          </>
                        ) : null}
                      </div>
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Job queue" description="Durable queue state, worker throughput and the oldest waiting job.">
        {obs.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {Object.entries(obs.data?.queue.counts ?? {}).map(([key, value]) => (
                <Badge key={key} variant="outline" className="h-6 px-2 text-[11px] capitalize">
                  {key}: {value as number}
                </Badge>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Average processing time: {obs.data?.queue.averageMs ? `${obs.data.queue.averageMs}ms` : "no completed job to measure"} · Oldest queued job: {when(obs.data?.queue.oldestQueued)}
            </p>
            {(obs.data?.queue.jobs.length ?? 0) === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">No integration job has been queued yet.</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {obs.data?.queue.jobs.map((job: any) => (
                  <li key={job.id} className="break-words rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground">
                    {job.provider} · {job.job_type} · {job.status} · attempt {job.attempts}/{job.max_attempts} · created {when(job.created_at)}
                    {job.last_error ? ` · ${job.last_error}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Section>

      <Section title="Provider health" description="Measured from recorded provider tests and API requests, including circuit-breaker state.">
        {(obs.data?.providers.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">No platform has been tested yet, so there is nothing measured to show.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="py-1 pr-3">Platform</th>
                  <th className="py-1 pr-3">Status</th>
                  <th className="py-1 pr-3">Requests</th>
                  <th className="py-1 pr-3">Failure rate</th>
                  <th className="py-1 pr-3">Avg latency</th>
                  <th className="py-1 pr-3">Circuit</th>
                  <th className="py-1 pr-3">Rate limit</th>
                  <th className="py-1">Last checked</th>
                </tr>
              </thead>
              <tbody>
                {obs.data?.providers.map((provider: any) => (
                  <tr key={provider.provider} className="border-t border-border/60 align-top">
                    <td className="py-1 pr-3">{provider.provider}</td>
                    <td className="py-1 pr-3 uppercase text-muted-foreground">{provider.status}</td>
                    <td className="py-1 pr-3">{provider.requests}</td>
                    <td className="py-1 pr-3">{provider.failureRate === null ? "—" : `${provider.failureRate}%`}</td>
                    <td className="py-1 pr-3">{provider.averageMs ?? provider.latencyMs ?? "—"}</td>
                    <td className="py-1 pr-3 uppercase text-muted-foreground">
                      {provider.circuitState}
                      {provider.circuitCooldownUntil ? ` until ${when(provider.circuitCooldownUntil)}` : ""}
                    </td>
                    <td className="py-1 pr-3 text-muted-foreground">
                      {provider.rateLimit ? `${provider.rateLimit.remaining ?? "?"}/${provider.rateLimit.limit ?? "?"}` : "not reported"}
                    </td>
                    <td className="py-1 text-muted-foreground">{when(provider.lastCheckedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="AI health" description="Real AI runs from the last 7 days, grouped by the model that answered.">
        {(obs.data?.ai.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">No AI run has been recorded in the last 7 days.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {obs.data?.ai.map((row: any) => (
              <li key={row.model} className="rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground">
                <span className="text-foreground">{row.model}</span> · {row.requests} requests · {row.success} succeeded · {row.failure} failed · average {row.averageMs}ms · {row.inputTokens} in / {row.outputTokens} out tokens
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Slowest stages" description="Average duration per collection source, measured from stored scan timings.">
        {(obs.data?.performance.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">No timing has been recorded yet.</p>
        ) : (
          <ul className="space-y-1 text-xs text-muted-foreground">
            {obs.data?.performance.map((row: any) => (
              <li key={row.source}>
                {row.source}: average {row.averageMs}ms over {row.runs} runs · {row.failures} failed
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Error center" description="Application, API, integration, crawler, AI and worker errors in one feed.">
        {(obs.data?.errors.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">No error has been recorded.</p>
        ) : (
          <ul className="space-y-1">
            {obs.data?.errors.map((error: any, index: number) => (
              <li key={index} className="break-words rounded-md border border-border/60 px-2 py-1 text-xs">
                <span className="font-medium">{error.component}</span> · {error.operation} · <span className={error.severity === "error" ? "text-negative" : "text-rating-foreground"}>{error.severity}</span>
                <span className="text-muted-foreground"> · {error.reference ?? "—"} · {when(error.at)}</span>
                <p className="text-muted-foreground">{error.message}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Security events" description="Blocked targets, permission failures, invalid callbacks and other suspicious activity. Kept separate from normal logs.">
        {(obs.data?.security.length ?? 0) === 0 ? (
          <EmptyState icon={ShieldAlert} title="No security event recorded" description="Nothing suspicious has been detected and stored for this workspace." />
        ) : (
          <ul className="space-y-1">
            {obs.data?.security.map((event: any, index: number) => (
              <li key={index} className="break-words rounded-md border border-border/60 px-2 py-1 text-xs">
                <span className="font-medium capitalize">{event.category}</span> · {event.event_type} ·{" "}
                <Badge variant="outline" className="h-4 px-1 text-[10px] uppercase">
                  {event.severity}
                </Badge>
                <span className="text-muted-foreground"> · {when(event.created_at)}</span>
                <p className="text-muted-foreground">{event.message}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Audit log" description="Who did what, and when. Credentials are never recorded.">
        {(obs.data?.audit.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">No audited action has been recorded yet.</p>
        ) : (
          <ul className="space-y-1 text-xs text-muted-foreground">
            {obs.data?.audit.map((entry: any, index: number) => (
              <li key={index} className="break-words rounded-md border border-border/60 px-2 py-1">
                {entry.action} · {entry.target_type ?? "—"} {entry.target_id ?? ""} · {when(entry.created_at)}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {obs.error ? (
        <p className="flex items-center gap-2 text-sm text-negative">
          <AlertTriangle className="h-4 w-4" /> {(obs.error as Error).message}
        </p>
      ) : null}
    </AppShell>
  );
}
