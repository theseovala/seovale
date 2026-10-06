import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Radar,
  Loader2,
  Download,
  RefreshCw,
  ChevronDown,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  Trash2,
  Pause,
  Play,
  Ban,
} from "lucide-react";
import { AppShell } from "@/components/app/AppShell";
import { PageHeader, Section, EmptyState } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useRealtimeInvalidate } from "@/hooks/use-realtime";
import {
  createScan,
  runScanNow,
  listScans,
  getScan,
  exportScanCsv,
  deleteScan,
  pauseScan,
  resumeScan,
  cancelScan,
  setFindingStatus,
} from "@/lib/scan.functions";

export const Route = createFileRoute("/_authenticated/scans")({
  head: () => ({
    meta: [
      { title: "Website Scan Engine — Seovale" },
      {
        name: "description",
        content:
          "Scan any website address for real technical, SEO, security, DNS and domain findings, with evidence, AI priorities and CSV export.",
      },
      { property: "og:title", content: "Website Scan Engine — Seovale" },
      { property: "og:description", content: "Real URL scanning with evidence-backed findings and CSV export." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  validateSearch: (search: Record<string, unknown>): { scan?: string } =>
    typeof search["scan"] === "string" ? { scan: search["scan"] as string } : {},
  component: ScansPage,
});

const SOURCE_LABEL: Record<string, string> = {
  http: "Website page",
  tls: "HTTPS / certificate",
  dns: "DNS records",
  rdap: "Domain registration",
  crawl_directives: "robots.txt & sitemap",
  crawl: "Website crawl",
  pagespeed: "Google PageSpeed",
  ai_analysis: "AI analysis",
};

/** Platform rows are stored as `platform:<provider>` — shown with a readable name. */
function sourceLabel(source: string) {
  if (source.startsWith("platform:")) {
    const provider = source.slice("platform:".length);
    return provider.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return SOURCE_LABEL[source] ?? source;
}

const SOURCE_STATUS_LABEL: Record<string, string> = {
  completed: "Checked",
  not_configured: "Not configured",
  auth_required: "Sign-in needed",
  approval_required: "Approval needed",
  not_supported: "No public API",
  unavailable: "Unavailable",
  rate_limited: "Rate limited",
  skipped: "Skipped",
  failed: "Failed",
};

const SCAN_STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  paused: "Paused",
  retrying: "Retrying",
  completed: "Completed",
  completed_with_warnings: "Completed with warnings",
  failed: "Failed",
  cancelled: "Cancelled",
};

const SEVERITY_TONE: Record<string, string> = {
  critical: "bg-destructive/15 text-destructive border-destructive/30",
  high: "bg-destructive/10 text-destructive border-destructive/20",
  medium: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  low: "bg-muted text-muted-foreground border-border",
  info: "bg-muted text-muted-foreground border-border",
};

function SourceIcon({ status }: { status: string }) {
  if (status === "completed") return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
  if (["not_configured", "skipped", "not_supported", "unavailable", "approval_required", "auth_required", "rate_limited"].includes(status)) {
    return <Clock className="h-4 w-4 text-muted-foreground" />;
  }
  return <XCircle className="h-4 w-4 text-destructive" />;
}

const FINDING_FILTERS = ["all", "critical", "high", "medium", "low", "open", "resolved", "new", "changed"] as const;


function ScansPage() {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const activeId = search.scan ?? null;
  const setActiveId = (id: string | null) =>
    void navigate({ search: id ? { scan: id } : {}, replace: true });
  const [openFinding, setOpenFinding] = useState<string | null>(null);
  const [findingFilter, setFindingFilter] = useState<(typeof FINDING_FILTERS)[number]>("all");


  const scans = useQuery({ queryKey: ["scans"], queryFn: () => listScans() });
  const detail = useQuery({
    queryKey: ["scan", activeId],
    queryFn: () => getScan({ data: { id: activeId as string } }),
    enabled: Boolean(activeId),
    // Stage and status changes are pushed by the server; this slow poll only
    // covers a dropped websocket while a scan is still running.
    refetchInterval: (query) => {
      const status = (query.state.data as any)?.scan?.status;
      return status === "queued" || status === "running" || status === "retrying" ? 15000 : false;
    },
  });

  // Live scan progress: every stage row the engine writes pushes an update.
  useRealtimeInvalidate("scan-progress", ["scans", "scan_stages"], [["scans"], ["scan", activeId ?? undefined]]);


  // Finding triage writes straight to the stored finding row, then the detail
  // query is refetched so filters, report and CSV all show the same status.
  const triage = useMutation({
    mutationFn: (input: { findingId: string; status: "open" | "resolved" | "ignored" }) =>
      setFindingStatus({ data: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["scan"] });
      toast.success("Finding updated.");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  // The scan runs on the server; the browser is never blocked while it works.
  // The detail query below polls until the stored status leaves queued/running.
  const start = useMutation({
    mutationFn: async (target: string) => {
      const created = await createScan({ data: { url: target } });
      setActiveId(created.id);
      await queryClient.invalidateQueries({ queryKey: ["scans"] });
      runScanNow({ data: { id: created.id } })
        .then(() => {
          queryClient.invalidateQueries({ queryKey: ["scans"] });
          queryClient.invalidateQueries({ queryKey: ["scan"] });
        })
        .catch((error: Error) => toast.error(error.message));
      return created;
    },
    onSuccess: (created: any) =>
      created?.reused
        ? toast.info("A scan for this address is already running — showing it")
        : toast.success("Scan started — results appear as each source answers"),
    onError: (error: Error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteScan({ data: { id } }),
    onSuccess: () => {
      setActiveId(null);
      toast.success("Scan deleted");
      queryClient.invalidateQueries({ queryKey: ["scans"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const rescan = useMutation({
    mutationFn: async (target: string) => {
      const created = await createScan({ data: { url: target } });
      setActiveId(created.id);
      return await runScanNow({ data: { id: created.id } });
    },
    onSuccess: () => {
      toast.success("Re-scan complete");
      queryClient.invalidateQueries({ queryKey: ["scans"] });
      queryClient.invalidateQueries({ queryKey: ["scan"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const download = useMutation({
    mutationFn: (id: string) => exportScanCsv({ data: { id } }),
    onSuccess: (result) => {
      const blob = new Blob([result.csv], { type: "text/csv;charset=utf-8" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = result.filename;
      link.click();
      URL.revokeObjectURL(link.href);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const refreshScan = () => {
    queryClient.invalidateQueries({ queryKey: ["scans"] });
    queryClient.invalidateQueries({ queryKey: ["scan"] });
  };

  const pause = useMutation({
    mutationFn: (id: string) => pauseScan({ data: { id } }),
    onSuccess: () => {
      toast.success("Scan paused after the current stage");
      refreshScan();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const resume = useMutation({
    mutationFn: (id: string) => resumeScan({ data: { id } }),
    onSuccess: () => {
      toast.success("Scan resumed");
      refreshScan();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const stop = useMutation({
    mutationFn: (id: string) => cancelScan({ data: { id } }),
    onSuccess: () => {
      toast.success("Scan cancelled");
      refreshScan();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const data = detail.data as any;
  const busy = start.isPending || rescan.isPending;

  return (
    <AppShell>
      <PageHeader
        title="Website Scan Engine"
        description="Paste a website address. Seovale checks it live and reports only what it actually measured."
      />

      <Section title="New scan" description="One address per scan. Everything measured is stored with its evidence and timestamp.">
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (url.trim()) start.mutate(url.trim());
          }}
        >
          <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="seovale.com" className="sm:max-w-md" />
          <Button type="submit" disabled={busy || !url.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radar className="h-4 w-4" />}
            {busy ? "Scanning…" : "Start scan"}
          </Button>
        </form>
      </Section>

      <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <Section className="min-w-0" title="Scan history" description="Completed scans are kept so results can be compared over time.">
          {scans.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading
            </div>
          ) : (scans.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No scans yet.</p>
          ) : (
            <ul className="stagger space-y-1">
              {(scans.data as any[]).map((scan) => (
                <li key={scan.id}>
                  <button
                    type="button"
                    onClick={() => setActiveId(scan.id)}
                    className={cn(
                      "press w-full rounded-lg border px-3 py-2 text-left text-sm transition-all",
                      activeId === scan.id
                        ? "edge-illuminate border-primary/40 bg-primary/5 shadow-[0_0_0_1px_color-mix(in_oklab,var(--primary)_22%,transparent)]"
                        : "border-border hover:bg-muted/50 hover-glow",
                    )}
                  >
                    <span className="block truncate font-medium">{scan.target_domain}</span>
                    <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="outline" className="h-5 px-1.5 text-[10px] uppercase">
                        {SCAN_STATUS_LABEL[scan.status] ?? scan.status}

                      </Badge>
                      <span className="num">{scan.score === null ? "No score" : `${scan.score}/100`}</span>
                      <span>· {new Date(scan.created_at).toLocaleString()}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <div className="min-w-0 space-y-4">
          {!activeId ? (
            <Section title="Scan result">
              <EmptyState icon={Radar} title="No scan selected" description="Start a scan or pick one from the history to see its findings and evidence." />
            </Section>
          ) : detail.isLoading || !data ? (
            <Section title="Scan result">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading scan
              </div>
            </Section>
          ) : (
            <>
              <Section
                title={data.scan.target_domain}
                description={`${SCAN_STATUS_LABEL[data.scan.status] ?? data.scan.status} · ${data.scan.score === null ? "Score unavailable" : `Score ${data.scan.score}/100`}`}
                action={
                  <div className="flex flex-wrap gap-2">
                    {["queued", "running", "retrying"].includes(data.scan.status) ? (
                      <>
                        <Button variant="outline" size="sm" onClick={() => pause.mutate(data.scan.id)} disabled={pause.isPending}>
                          {pause.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pause className="h-4 w-4" />} Pause
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => stop.mutate(data.scan.id)} disabled={stop.isPending}>
                          {stop.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />} Cancel
                        </Button>
                      </>
                    ) : null}
                    {["paused", "failed", "cancelled"].includes(data.scan.status) ? (
                      <Button variant="outline" size="sm" onClick={() => resume.mutate(data.scan.id)} disabled={resume.isPending}>
                        {resume.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                        {data.scan.status === "paused" ? "Resume" : "Retry"}
                      </Button>
                    ) : null}
                    <Button variant="outline" size="sm" onClick={() => rescan.mutate(data.scan.target_url)} disabled={busy}>
                      {rescan.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Re-scan
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => download.mutate(data.scan.id)} disabled={download.isPending}>
                      <Download className="h-4 w-4" /> CSV
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => remove.mutate(data.scan.id)}
                      disabled={remove.isPending}
                      aria-label="Delete this scan and its stored data"
                    >
                      {remove.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Delete
                    </Button>
                  </div>
                }
              >
                {data.scan.error_message ? (
                  <p className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{data.scan.error_message}</p>
                ) : null}
                {data.report?.ai_status === "failed" ? (
                  <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                    AI analysis failed for this scan, so no interpretation is shown. The measured findings below are unaffected.
                    {data.report?.ai_error ? <span className="mt-1 block text-xs opacity-80">{data.report.ai_error}</span> : null}
                  </p>
                ) : null}
                <p className="text-sm text-muted-foreground">
                  {data.report?.summary ? data.report.summary : "AI summary unavailable for this scan."}
                </p>
                {data.report?.model ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Analysed by {data.report.model}
                    {data.report?.ai_latency_ms ? ` in ${(data.report.ai_latency_ms / 1000).toFixed(1)}s` : ""}
                  </p>
                ) : null}

              </Section>

              {(data.stages ?? []).length > 0 ? (
                <Section
                  title="Scan progress"
                  description="Each step is recorded by the engine itself, so it survives a page refresh."
                >
                  <ul className="space-y-1.5">
                    {(data.stages as any[]).map((item) => (
                      <li key={item.stage} className="flex items-start gap-2 text-sm">
                        <span className="icon-tile mt-0.5">
                          {item.status === "completed" ? (
                            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                          ) : item.status === "running" ? (
                            <Loader2 className="h-4 w-4 animate-spin text-primary" />
                          ) : item.status === "failed" ? (
                            <XCircle className="h-4 w-4 text-destructive" />
                          ) : (
                            <Clock className="h-4 w-4 text-muted-foreground" />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium">{item.label}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {item.detail ??
                              (item.status === "pending"
                                ? "Waiting"
                                : item.status === "running"
                                  ? "In progress"
                                  : item.status)}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}

              <Section title="Scan health" description="Every technical check that ran, with what it returned.">
                <ul className="stagger grid gap-2 sm:grid-cols-2">
                  {data.sources
                    .filter((source: any) => !String(source.source).startsWith("platform:"))
                    .map((source: any) => (
                      <li
                        key={source.source}
                        className="card-interactive flex items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm"
                      >
                        <span className="icon-tile mt-0.5">
                          <SourceIcon status={source.status} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 font-medium">
                            <span className="truncate">{sourceLabel(source.source)}</span>
                            {source.status === "completed" ? (
                              <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px] uppercase">
                                {source.freshness}
                              </Badge>
                            ) : null}
                          </div>
                          <p className="truncate text-xs text-muted-foreground">
                            {source.error_message
                              ? source.error_message
                              : source.status === "completed"
                                ? `Retrieved ${new Date(source.created_at).toLocaleString()}`
                                : (SOURCE_STATUS_LABEL[source.status] ?? source.status)}
                          </p>
                        </div>
                      </li>
                    ))}
                </ul>
              </Section>

              {data.sources.some((source: any) => String(source.source).startsWith("platform:")) ? (
                <Section
                  title="Platforms checked"
                  description="Which review and marketing platforms apply to this website, and whether this workspace can actually use them."
                >
                  <ul className="stagger grid gap-2 sm:grid-cols-2">
                    {data.sources
                      .filter((source: any) => String(source.source).startsWith("platform:"))
                      .map((source: any) => (
                        <li
                          key={source.source}
                          className="card-interactive flex items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm"
                        >
                          <span className="icon-tile mt-0.5">
                            <SourceIcon status={source.status} />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 font-medium">
                              <span className="truncate">{sourceLabel(source.source)}</span>
                              <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px] uppercase">
                                {SOURCE_STATUS_LABEL[source.status] ?? source.status}
                              </Badge>
                            </div>
                            <p className="truncate text-xs text-muted-foreground">
                              {source.error_message ?? "Connection verified against the provider."}
                            </p>
                          </div>
                        </li>
                      ))}
                  </ul>
                </Section>
              ) : null}


              {data.comparison ? (
                <Section title="Compared with the previous scan" description={`Previous scan ${new Date(data.comparison.previousAt).toLocaleString()} · score ${data.comparison.previousScore ?? "unavailable"}`}>
                  <div className="grid gap-3 sm:grid-cols-3 text-sm">
                    <div>
                      <p className="font-medium text-emerald-600">Resolved ({data.comparison.resolved.length})</p>
                      <ul className="mt-1 space-y-1 text-muted-foreground">
                        {data.comparison.resolved.slice(0, 6).map((item: any) => <li key={item.code}>{item.title}</li>)}
                        {data.comparison.resolved.length === 0 ? <li>None</li> : null}
                      </ul>
                    </div>
                    <div>
                      <p className="font-medium text-destructive">New issues ({data.comparison.introduced.length})</p>
                      <ul className="mt-1 space-y-1 text-muted-foreground">
                        {data.comparison.introduced.slice(0, 6).map((item: any) => <li key={item.code}>{item.title}</li>)}
                        {data.comparison.introduced.length === 0 ? <li>None</li> : null}
                      </ul>
                    </div>
                    <div>
                      <p className="font-medium">Unchanged</p>
                      <p className="mt-1 text-muted-foreground">{data.comparison.unchanged} findings</p>
                    </div>
                  </div>
                </Section>
              ) : null}

              {Array.isArray(data.report?.action_plan) && (data.report!.action_plan as any[]).length > 0 ? (
                <Section title="Action plan" description="Ordered by the deterministic priority score, explained by AI from the stored findings.">
                  <ol className="space-y-2">
                    {(data.report!.action_plan as any[]).map((item, index) => (
                      <li key={`${item.findingCode}-${index}`} className="rounded-lg border border-border px-3 py-2 text-sm">
                        <p className="font-medium">
                          {index + 1}. {item.problem}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">Why it matters: {item.impact}</p>
                        <p className="mt-1 text-xs text-muted-foreground">Do this: {item.action}</p>
                        <p className="mt-1 text-xs text-muted-foreground">Objective: {item.expectedObjective}</p>
                        <button
                          type="button"
                          className="press mt-2 text-xs underline underline-offset-2"
                          onClick={() => setOpenFinding(item.findingCode)}
                        >
                          View evidence ({item.findingCode})
                        </button>
                      </li>
                    ))}
                  </ol>
                </Section>
              ) : null}

              <Section
                title={`Findings (${data.findings.length})`}
                description="Each finding links back to the measurement it came from."
                action={
                  <div className="flex flex-wrap gap-1">
                    {FINDING_FILTERS.map((option) => (
                      <button
                        key={option}
                        type="button"
                        onClick={() => setFindingFilter(option)}
                        className={cn(
                          "press rounded-full border border-border px-2.5 py-1 text-[11px] capitalize",
                          findingFilter === option ? "bg-primary text-primary-foreground" : "text-muted-foreground",
                        )}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                }
              >
                {(() => {
                  const visible = (data.findings as any[]).filter((finding) => {
                    if (findingFilter === "all") return true;
                    if (["critical", "high", "medium", "low"].includes(findingFilter)) return finding.severity === findingFilter;
                    if (findingFilter === "open" || findingFilter === "resolved") return (finding.status ?? "open") === findingFilter;
                    return (finding.change_state ?? "new") === findingFilter;
                  });
                  if (data.findings.length === 0) {
                    return <p className="text-sm text-muted-foreground">No issues were detected in what could be measured.</p>;
                  }
                  if (visible.length === 0) {
                    return <p className="text-sm text-muted-foreground">No findings match this filter.</p>;
                  }
                  return (
                    <ul className="stagger space-y-2">
                      {visible.map((finding: any) => (
                        <li
                          key={finding.code}
                          className={cn(
                            "card-interactive overflow-hidden rounded-lg border border-border",
                            openFinding === finding.code && "edge-illuminate",
                          )}
                        >
                          <button
                            type="button"
                            className="press flex w-full items-start gap-3 px-3 py-2 text-left"
                            aria-expanded={openFinding === finding.code}
                            onClick={() => setOpenFinding(openFinding === finding.code ? null : finding.code)}
                          >
                            <span className="icon-tile mt-0.5">
                              <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-medium">
                                {finding.priority_rank ? <span className="text-muted-foreground">#{finding.priority_rank} </span> : null}
                                {finding.title}
                              </span>
                              <span className="block text-xs text-muted-foreground">{finding.detail}</span>
                            </span>
                            {finding.change_state && finding.change_state !== "unchanged" ? (
                              <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[10px] uppercase">
                                {finding.change_state}
                              </Badge>
                            ) : null}
                            <Badge variant="outline" className={cn("h-5 shrink-0 px-1.5 text-[10px] uppercase", SEVERITY_TONE[finding.severity])}>
                              {finding.severity}
                            </Badge>
                            <ChevronDown className={cn("h-4 w-4 shrink-0 transition-transform", openFinding === finding.code && "rotate-180")} />
                          </button>
                          {openFinding === finding.code ? (
                            <div className="animate-fade-in border-t border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                              {finding.recommendation ? <p className="mb-2 text-foreground">Recommendation: {finding.recommendation}</p> : null}
                              <p>
                                Source: {SOURCE_LABEL[finding.source] ?? finding.source} · Confidence: {finding.confidence ?? "measured"} · Impact: -{finding.impact}
                                {finding.priority_score ? ` · Priority score: ${Number(finding.priority_score).toFixed(1)}` : ""} · Status: {finding.status ?? "open"}
                              </p>
                              {finding.evidenceRecords?.length ? (
                                <div className="mt-2 space-y-1">
                                  <p className="text-[11px] font-medium uppercase text-foreground">Evidence ({finding.evidenceRecords.length})</p>
                                  {finding.evidenceRecords.map((record: any, index: number) => (
                                    <p key={`${record.sourceType}-${index}`} className="break-words rounded-md bg-muted/60 px-2 py-1 text-[11px]">
                                      <span className="text-foreground">{record.sourceType.replace(/_/g, " ")}:</span> {record.value}
                                      <span className="text-muted-foreground"> · {SOURCE_LABEL[record.source] ?? record.source} · observed {new Date(record.observedAt).toLocaleString()}</span>
                                    </p>
                                  ))}
                                </div>
                              ) : (
                                <p className="mt-2 text-[11px]">No separate evidence record was stored for this finding.</p>
                              )}
                              <div className="mt-3 flex flex-wrap gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={triage.isPending}
                                  onClick={() =>
                                    triage.mutate({
                                      findingId: finding.id,
                                      status: (finding.status ?? "open") === "resolved" ? "open" : "resolved",
                                    })
                                  }
                                >
                                  {(finding.status ?? "open") === "resolved" ? "Reopen" : "Mark resolved"}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={triage.isPending}
                                  onClick={() =>
                                    triage.mutate({
                                      findingId: finding.id,
                                      status: (finding.status ?? "open") === "ignored" ? "open" : "ignored",
                                    })
                                  }
                                >
                                  {(finding.status ?? "open") === "ignored" ? "Un-ignore" : "Ignore"}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => {
                                    void navigator.clipboard
                                      .writeText(
                                        `${finding.title}\n${finding.detail}\n${finding.recommendation ?? ""}`.trim(),
                                      )
                                      .then(() => toast.success("Finding copied."))
                                      .catch(() => toast.error("Could not copy this finding."));
                                  }}
                                >
                                  Copy
                                </Button>
                              </div>
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  );
                })()}
              </Section>

              <Section
                title={`Source conflicts (${(data.conflicts ?? []).filter((row: any) => row.status === "open").length} open)`}
                description="Where two sources disagree about the same detail. Neither value is chosen automatically."
              >
                {(data.conflicts ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No disagreement was found between the sources that could be read.</p>
                ) : (
                  <ul className="space-y-2">
                    {(data.conflicts as any[]).map((row) => (
                      <li key={`${row.field_key}-${row.source_a}-${row.source_b}`} className="rounded-lg border border-border px-3 py-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium capitalize">{row.field_key.replace(/_/g, " ")}</span>
                          <Badge variant="outline" className="h-5 px-1.5 text-[10px] uppercase">
                            {row.status}
                          </Badge>
                        </div>
                        <p className="mt-1 break-words text-muted-foreground">
                          {row.source_a}: <span className="text-foreground">{row.value_a}</span> · observed {new Date(row.observed_a_at).toLocaleString()}
                        </p>
                        <p className="break-words text-muted-foreground">
                          {row.source_b}: <span className="text-foreground">{row.value_b}</span> · observed {new Date(row.observed_b_at).toLocaleString()}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section
                title={`Verified business details (${(data.facts ?? []).length})`}
                description="One canonical record per detail and source, with the origin, confidence and last verification kept."
              >
                {(data.facts ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No business detail could be read from the available sources.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs uppercase text-muted-foreground">
                          <th className="py-1 pr-3">Detail</th>
                          <th className="py-1 pr-3">Value</th>
                          <th className="py-1 pr-3">Source</th>
                          <th className="py-1 pr-3">Confidence</th>
                          <th className="py-1">Last verified</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(data.facts as any[]).map((fact) => (
                          <tr key={`${fact.field_key}-${fact.source_provider}`} className="border-t border-border/60 align-top">
                            <td className="py-1 pr-3 capitalize text-muted-foreground">{fact.field_key.replace(/_/g, " ")}</td>
                            <td className="max-w-[22rem] break-words py-1 pr-3">
                              {fact.value_raw ?? fact.value_normalized}
                              {fact.previous_value ? (
                                <span className="block text-[11px] text-muted-foreground">was: {fact.previous_value}</span>
                              ) : null}
                            </td>
                            <td className="py-1 pr-3 text-muted-foreground">{fact.source_provider}</td>
                            <td className="py-1 pr-3 uppercase text-muted-foreground">{fact.confidence}</td>
                            <td className="py-1 text-muted-foreground">{new Date(fact.last_verified_at).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Section>



              <Section title={`Measurements (${data.metrics.length})`} description="Normalized values taken straight from the collected data.">
                {data.metrics.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Data unavailable.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs uppercase text-muted-foreground">
                          <th className="py-1 pr-3">Category</th>
                          <th className="py-1 pr-3">Measurement</th>
                          <th className="py-1 pr-3">Value</th>
                          <th className="py-1">Source</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.metrics.map((metric: any) => (
                          <tr key={`${metric.category}-${metric.metric_key}`} className="border-t border-border/60">
                            <td className="py-1 pr-3 text-muted-foreground">{metric.category}</td>
                            <td className="py-1 pr-3">{metric.metric_key.replace(/_/g, " ")}</td>
                            <td className="py-1 pr-3">
                              {metric.value_numeric ?? metric.value_text ?? "DATA NOT AVAILABLE"}
                              {metric.unit ? ` ${metric.unit}` : ""}
                            </td>
                            <td className="py-1 text-muted-foreground">{SOURCE_LABEL[metric.source] ?? metric.source}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Section>
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}
