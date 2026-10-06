// Production control center API. Every number here is measured at call time or
// read from stored operational records — nothing is assumed healthy.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type Ctx = { supabase: any; userId: string };

export type HealthStatus = "healthy" | "degraded" | "failed" | "not_configured";

export interface ComponentHealth {
  component: string;
  status: HealthStatus;
  detail: string;
  latencyMs: number | null;
  checkedAt: string;
}

async function workspace(context: Ctx) {
  const { data, error } = await context.supabase
    .from("workspace_members")
    .select("workspace_id, role")
    .eq("user_id", context.userId)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("No workspace is assigned to this account.");
  return data as { workspace_id: string; role: string };
}

function timed<T>(fn: () => Promise<T>) {
  const started = Date.now();
  return fn().then(
    (value) => ({ value, error: null as unknown, ms: Date.now() - started }),
    (error) => ({ value: null as T | null, error, ms: Date.now() - started }),
  );
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Runs real checks against every subsystem. No static values. */
export const getSystemHealth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const member = await workspace(context as Ctx);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { recoverStalled } = await import("@/lib/ops.server");
    const now = () => new Date().toISOString();
    const components: ComponentHealth[] = [];

    // Recover anything stuck before reporting, so the numbers below are current.
    const recovered = await recoverStalled(supabaseAdmin, member.workspace_id);

    // Database — a real round trip.
    const db = await timed(async () => {
      const { error, count } = await supabaseAdmin
        .from("scans")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", member.workspace_id);
      if (error) throw error;
      return count ?? 0;
    });
    components.push({
      component: "Database",
      status: db.error ? "failed" : db.ms > 1500 ? "degraded" : "healthy",
      detail: db.error ? String((db.error as Error).message) : `Round trip answered with ${db.value} scans stored.`,
      latencyMs: db.ms,
      checkedAt: now(),
    });

    // Application — this request itself reached the server runtime.
    components.push({
      component: "Application",
      status: "healthy",
      detail: "Server runtime answered this request.",
      latencyMs: null,
      checkedAt: now(),
    });

    // Scan engine — measured from stored scan outcomes in the last 24 hours.
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const { data: recentScans } = await supabaseAdmin
      .from("scans")
      .select("status,duration_ms,created_at")
      .eq("workspace_id", member.workspace_id)
      .gte("created_at", since);
    const scanRows = recentScans ?? [];
    const failedScans = scanRows.filter((r: any) => r.status === "failed").length;
    components.push({
      component: "Scan engine",
      status: scanRows.length === 0 ? "not_configured" : failedScans === 0 ? "healthy" : failedScans >= scanRows.length / 2 ? "failed" : "degraded",
      detail:
        scanRows.length === 0
          ? "No scan has run in the last 24 hours, so there is nothing to measure."
          : `${scanRows.length} scans in 24h · ${failedScans} failed · average ${Math.round(scanRows.reduce((sum: number, r: any) => sum + (r.duration_ms ?? 0), 0) / scanRows.length)}ms`,
      latencyMs: null,
      checkedAt: now(),
    });

    // Queue and workers — read from the durable job table.
    const { data: jobs } = await supabaseAdmin
      .from("integration_sync_jobs")
      .select("status,created_at,started_at,completed_at,next_attempt_at")
      .eq("workspace_id", member.workspace_id)
      .order("created_at", { ascending: false })
      .limit(500);
    const jobRows = jobs ?? [];
    const queued = jobRows.filter((j: any) => j.status === "pending" || j.status === "retrying");
    const running = jobRows.filter((j: any) => j.status === "processing");
    const failedJobs = jobRows.filter((j: any) => j.status === "failed");
    const oldestQueued = queued.reduce<string | null>((oldest, j: any) => (!oldest || j.created_at < oldest ? j.created_at : oldest), null);
    components.push({
      component: "Job queue",
      status: jobRows.length === 0 ? "not_configured" : failedJobs.length > 0 ? "degraded" : "healthy",
      detail:
        jobRows.length === 0
          ? "No integration job has been queued yet."
          : `${queued.length} queued · ${running.length} running · ${failedJobs.length} failed`,
      latencyMs: null,
      checkedAt: now(),
    });
    const lastCompleted = jobRows.find((j: any) => j.completed_at);
    components.push({
      component: "Workers",
      status:
        jobRows.length === 0
          ? "not_configured"
          : oldestQueued && Date.now() - new Date(oldestQueued).getTime() > 30 * 60_000
            ? "failed"
            : "healthy",
      detail: lastCompleted
        ? `Last job finished ${new Date(String(lastCompleted.completed_at)).toLocaleString()}.${oldestQueued ? ` Oldest waiting job queued ${new Date(oldestQueued).toLocaleString()}.` : ""}`
        : "No job has been processed yet.",
      latencyMs: null,
      checkedAt: now(),
    });

    // AI providers — a real call to the configured gateway.
    const aiKey = process.env["LOVABLE_API_KEY"];
    if (!aiKey) {
      components.push({ component: "AI providers", status: "not_configured", detail: "No AI gateway key is configured.", latencyMs: null, checkedAt: now() });
    } else {
      const ai = await timed(() =>
        fetchWithTimeout("https://ai.gateway.lovable.dev/v1/models", { headers: { Authorization: `Bearer ${aiKey}` } }, 10_000),
      );
      const response = ai.value as Response | null;
      components.push({
        component: "AI providers",
        status: ai.error ? "failed" : response && response.ok ? "healthy" : "degraded",
        detail: ai.error
          ? `Gateway unreachable: ${(ai.error as Error).message}`
          : `Gateway answered HTTP ${response?.status}.`,
        latencyMs: ai.ms,
        checkedAt: now(),
      });
    }

    // Crawler — a real outbound HTTP request through the same guard the scanner uses.
    const crawler = await timed(async () => {
      const { assertPublicTarget } = await import("@/lib/scan/collectors.server");
      await assertPublicTarget("https://example.com/");
      const response = await fetchWithTimeout("https://example.com/", { method: "GET", redirect: "manual" }, 10_000);
      return response.status;
    });
    components.push({
      component: "Crawler",
      status: crawler.error ? "failed" : "healthy",
      detail: crawler.error ? `Outbound request failed: ${(crawler.error as Error).message}` : `Outbound request returned HTTP ${crawler.value}.`,
      latencyMs: crawler.ms,
      checkedAt: now(),
    });

    // External integrations — from recorded health of real provider tests.
    const { data: health } = await supabaseAdmin
      .from("integration_health")
      .select("provider,status,last_checked_at,last_error,latency_ms")
      .eq("workspace_id", member.workspace_id);
    const healthRows = health ?? [];
    const connected = healthRows.filter((h: any) => h.status === "connected").length;
    const broken = healthRows.filter((h: any) => h.status === "error" || h.status === "expired").length;
    components.push({
      component: "Integrations",
      status: healthRows.length === 0 ? "not_configured" : broken > 0 ? "degraded" : connected > 0 ? "healthy" : "not_configured",
      detail:
        healthRows.length === 0
          ? "No platform has been tested yet."
          : `${connected} verified connected · ${broken} needing attention · ${healthRows.length} tested`,
      latencyMs: null,
      checkedAt: now(),
    });

    // Report and CSV engines — measured from stored outputs.
    const { data: reports } = await supabaseAdmin
      .from("scan_reports")
      .select("ai_status,ai_error,created_at,ai_latency_ms")
      .eq("workspace_id", member.workspace_id)
      .order("created_at", { ascending: false })
      .limit(20);
    const reportRows = reports ?? [];
    const failedReports = reportRows.filter((r: any) => r.ai_status === "failed").length;
    components.push({
      component: "Report engine",
      status: reportRows.length === 0 ? "not_configured" : failedReports === 0 ? "healthy" : failedReports >= reportRows.length / 2 ? "failed" : "degraded",
      detail:
        reportRows.length === 0
          ? "No report has been generated yet."
          : `${reportRows.length} recent reports · ${failedReports} with a failed AI stage`,
      latencyMs: reportRows[0]?.ai_latency_ms ?? null,
      checkedAt: now(),
    });
    const { count: findingCount } = await supabaseAdmin
      .from("scan_findings")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", member.workspace_id);
    components.push({
      component: "CSV export",
      status: (findingCount ?? 0) > 0 ? "healthy" : "not_configured",
      detail:
        (findingCount ?? 0) > 0
          ? `${findingCount} stored findings are available to export.`
          : "There are no stored findings to export yet.",
      latencyMs: null,
      checkedAt: now(),
    });

    return { components, recovered, queue: { queued: queued.length, running: running.length, failed: failedJobs.length, oldestQueued } };
  });

/** Scan monitor rows with real per-scan stage, source and output state. */
export const listScanMonitor = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const member = await workspace(context as Ctx);
    const { data: scans } = await (context as Ctx).supabase
      .from("scans")
      .select("id,target_url,target_domain,status,score,attempts,max_attempts,duration_ms,error_message,started_at,completed_at,created_at")
      .eq("workspace_id", member.workspace_id)
      .order("created_at", { ascending: false })
      .limit(25);
    const rows = scans ?? [];
    if (rows.length === 0) return { scans: [] };
    const ids = rows.map((r: any) => r.id);
    const [{ data: stages }, { data: sources }, { data: reports }, { data: findings }] = await Promise.all([
      (context as Ctx).supabase.from("scan_stages").select("scan_id,stage,label,status,position").in("scan_id", ids).order("position"),
      (context as Ctx).supabase.from("scan_sources").select("scan_id,source,provider,status,duration_ms,http_status,error_message").in("scan_id", ids),
      (context as Ctx).supabase.from("scan_reports").select("scan_id,ai_status,ai_error,summary,ai_latency_ms").in("scan_id", ids),
      (context as Ctx).supabase.from("scan_findings").select("scan_id,id").in("scan_id", ids),
    ]);
    return {
      scans: rows.map((scan: any) => {
        const scanStages = (stages ?? []).filter((s: any) => s.scan_id === scan.id);
        const scanSources = (sources ?? []).filter((s: any) => s.scan_id === scan.id);
        const report = (reports ?? []).find((r: any) => r.scan_id === scan.id) ?? null;
        const findingCount = (findings ?? []).filter((f: any) => f.scan_id === scan.id).length;
        const done = scanStages.filter((s: any) => s.status === "completed").length;
        const current = scanStages.find((s: any) => s.status === "running") ?? null;
        return {
          ...scan,
          currentStage: current?.label ?? (scan.status === "completed" || scan.status === "completed_with_warnings" ? "Finished" : scanStages.at(-1)?.label ?? "Not started"),
          progress: scanStages.length ? Math.round((done / scanStages.length) * 100) : 0,
          providersUsed: scanSources.length,
          successfulSources: scanSources
            .filter((s: any) => s.status === "ok" || s.status === "success" || s.status === "completed")
            .map((s: any) => s.source),
          failedSources: scanSources
            .filter((s: any) => s.status === "failed" || s.status === "error" || s.status === "timeout")
            .map((s: any) => ({ source: s.source, status: s.status, httpStatus: s.http_status, error: s.error_message })),
          skippedSources: scanSources
            .filter((s: any) => !["ok", "success", "completed", "failed", "error", "timeout"].includes(s.status))
            .map((s: any) => ({ source: s.source, status: s.status })),
          aiStatus: report?.ai_status ?? "not run",
          aiError: report?.ai_error ?? null,
          reportStatus: report ? (report.summary ? "ready" : "stored without summary") : "not generated",
          csvStatus: findingCount > 0 ? "available" : "no findings to export",
          findingCount,
        };
      }),
    };
  });

/** Queue, API, provider, AI, error, security and audit feeds — all stored records. */
export const getObservability = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const member = await workspace(context as Ctx);
    const sb = (context as Ctx).supabase;
    const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const [jobs, apiLogs, health, rateLimits, circuits, aiRuns, events, security, audit, sources] = await Promise.all([
      sb.from("integration_sync_jobs").select("id,provider,job_type,status,attempts,max_attempts,last_error,created_at,started_at,completed_at,next_attempt_at").eq("workspace_id", member.workspace_id).order("created_at", { ascending: false }).limit(100),
      sb.from("integration_api_logs").select("provider,operation,method,endpoint,http_status,duration_ms,outcome_code,error_message,created_at").eq("workspace_id", member.workspace_id).order("created_at", { ascending: false }).limit(100),
      sb.from("integration_health").select("provider,status,latency_ms,outcome_code,last_error,last_checked_at,last_ok_at").eq("workspace_id", member.workspace_id),
      sb.from("integration_rate_limits").select("provider,limit_value,remaining,reset_at,source,recorded_at").eq("workspace_id", member.workspace_id).order("recorded_at", { ascending: false }).limit(50),
      sb.from("provider_circuits").select("provider,state,failure_count,last_failure_at,last_success_at,cooldown_until,last_error").eq("workspace_id", member.workspace_id),
      sb.from("ai_runs").select("purpose,model,status,duration_ms,error_message,input_tokens,output_tokens,created_at").eq("workspace_id", member.workspace_id).gte("created_at", since).order("created_at", { ascending: false }).limit(100),
      sb.from("integration_events").select("provider,event_type,level,message,http_status,created_at").eq("workspace_id", member.workspace_id).order("created_at", { ascending: false }).limit(100),
      sb.from("security_events").select("category,event_type,severity,message,provider,scan_id,created_at").eq("workspace_id", member.workspace_id).order("created_at", { ascending: false }).limit(50),
      sb.from("audit_logs").select("action,target_type,target_id,metadata,created_at").eq("workspace_id", member.workspace_id).order("created_at", { ascending: false }).limit(50),
      sb.from("scan_sources").select("source,provider,status,duration_ms,http_status,error_message,created_at").eq("workspace_id", member.workspace_id).order("created_at", { ascending: false }).limit(200),
    ]);

    const jobRows = jobs.data ?? [];
    const completedJobs = jobRows.filter((j: any) => j.completed_at && j.started_at);
    const averageMs = completedJobs.length
      ? Math.round(completedJobs.reduce((sum: number, j: any) => sum + (new Date(j.completed_at).getTime() - new Date(j.started_at).getTime()), 0) / completedJobs.length)
      : null;

    const aiRows = aiRuns.data ?? [];
    const aiByModel = new Map<string, { model: string; requests: number; success: number; failure: number; totalMs: number; inputTokens: number; outputTokens: number }>();
    for (const run of aiRows) {
      const key = run.model ?? "unknown";
      const entry = aiByModel.get(key) ?? { model: key, requests: 0, success: 0, failure: 0, totalMs: 0, inputTokens: 0, outputTokens: 0 };
      entry.requests += 1;
      if (run.status === "completed") entry.success += 1;
      else entry.failure += 1;
      entry.totalMs += run.duration_ms ?? 0;
      entry.inputTokens += run.input_tokens ?? 0;
      entry.outputTokens += run.output_tokens ?? 0;
      aiByModel.set(key, entry);
    }

    // Provider failure rate and latency from the stored request log.
    const providerStats = new Map<string, { provider: string; requests: number; failures: number; totalMs: number; lastSuccess: string | null; lastFailure: string | null }>();
    for (const log of apiLogs.data ?? []) {
      const entry = providerStats.get(log.provider) ?? { provider: log.provider, requests: 0, failures: 0, totalMs: 0, lastSuccess: null, lastFailure: null };
      entry.requests += 1;
      entry.totalMs += log.duration_ms ?? 0;
      const ok = typeof log.http_status === "number" && log.http_status < 400;
      if (ok) entry.lastSuccess = entry.lastSuccess ?? log.created_at;
      else {
        entry.failures += 1;
        entry.lastFailure = entry.lastFailure ?? log.created_at;
      }
      providerStats.set(log.provider, entry);
    }

    // Slowest scan stages measured from stored source timings.
    const stageStats = new Map<string, { source: string; runs: number; totalMs: number; failures: number }>();
    for (const row of sources.data ?? []) {
      const entry = stageStats.get(row.source) ?? { source: row.source, runs: 0, totalMs: 0, failures: 0 };
      entry.runs += 1;
      entry.totalMs += row.duration_ms ?? 0;
      if (row.status !== "ok" && row.status !== "success") entry.failures += 1;
      stageStats.set(row.source, entry);
    }

    const errors = [
      ...(events.data ?? [])
        .filter((e: any) => e.level === "error" || e.level === "warning")
        .map((e: any) => ({ component: "Integration", operation: e.event_type, message: e.message, severity: e.level, reference: e.provider, at: e.created_at })),
      ...(apiLogs.data ?? [])
        .filter((l: any) => l.error_message)
        .map((l: any) => ({ component: "API", operation: `${l.method} ${l.operation}`, message: l.error_message, severity: "error", reference: l.provider, at: l.created_at })),
      ...(aiRows.filter((r: any) => r.status !== "completed") ?? []).map((r: any) => ({ component: "AI", operation: r.purpose, message: r.error_message ?? "AI run did not complete", severity: "error", reference: r.model, at: r.created_at })),
      ...(sources.data ?? [])
        .filter((s: any) => s.error_message)
        .map((s: any) => ({ component: "Crawler", operation: s.source, message: s.error_message, severity: "warning", reference: s.provider, at: s.created_at })),
      ...jobRows
        .filter((j: any) => j.last_error)
        .map((j: any) => ({ component: "Worker", operation: j.job_type, message: j.last_error, severity: j.status === "failed" ? "error" : "warning", reference: j.provider, at: j.created_at })),
    ].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 80);

    return {
      queue: {
        jobs: jobRows.slice(0, 30),
        counts: {
          queued: jobRows.filter((j: any) => j.status === "pending").length,
          retrying: jobRows.filter((j: any) => j.status === "retrying").length,
          running: jobRows.filter((j: any) => j.status === "processing").length,
          completed: jobRows.filter((j: any) => j.status === "completed").length,
          failed: jobRows.filter((j: any) => j.status === "failed").length,
          cancelled: jobRows.filter((j: any) => j.status === "cancelled").length,
        },
        averageMs,
        oldestQueued: jobRows.filter((j: any) => j.status === "pending" || j.status === "retrying").map((j: any) => j.created_at).sort()[0] ?? null,
      },
      apiLogs: apiLogs.data ?? [],
      providers: (health.data ?? []).map((row: any) => {
        const stats = providerStats.get(row.provider);
        const circuit = (circuits.data ?? []).find((c: any) => c.provider === row.provider) ?? null;
        const limit = (rateLimits.data ?? []).find((r: any) => r.provider === row.provider) ?? null;
        return {
          provider: row.provider,
          status: row.status,
          latencyMs: row.latency_ms,
          outcomeCode: row.outcome_code,
          lastError: row.last_error,
          lastCheckedAt: row.last_checked_at,
          lastOkAt: row.last_ok_at,
          requests: stats?.requests ?? 0,
          failureRate: stats && stats.requests ? Math.round((stats.failures / stats.requests) * 100) : null,
          averageMs: stats && stats.requests ? Math.round(stats.totalMs / stats.requests) : null,
          circuitState: circuit?.state ?? "closed",
          circuitCooldownUntil: circuit?.cooldown_until ?? null,
          rateLimit: limit ? { remaining: limit.remaining, limit: limit.limit_value, resetAt: limit.reset_at, source: limit.source } : null,
        };
      }),
      ai: Array.from(aiByModel.values()).map((entry) => ({
        ...entry,
        averageMs: entry.requests ? Math.round(entry.totalMs / entry.requests) : null,
      })),
      performance: Array.from(stageStats.values())
        .map((entry) => ({ ...entry, averageMs: entry.runs ? Math.round(entry.totalMs / entry.runs) : 0 }))
        .sort((a, b) => b.averageMs - a.averageMs)
        .slice(0, 12),
      errors,
      security: security.data ?? [],
      audit: audit.data ?? [],
    };
  });

/** Full trace for one scan: stages, provider calls, AI runs, report and outputs. */
export const getScanTrace = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const member = await workspace(context as Ctx);
    const sb = (context as Ctx).supabase;
    const { data: scan } = await sb
      .from("scans")
      .select("id,target_url,target_domain,status,score,attempts,max_attempts,duration_ms,error_message,requested_by,created_at,started_at,completed_at,workspace_id")
      .eq("id", data.id)
      .eq("workspace_id", member.workspace_id)
      .maybeSingle();
    if (!scan) throw new Error("That scan does not exist in your workspace.");
    const [stages, sources, ai, report, findings, evidence, security] = await Promise.all([
      sb.from("scan_stages").select("stage,label,status,detail,position,started_at,completed_at").eq("scan_id", scan.id).order("position"),
      sb.from("scan_sources").select("source,provider,status,http_status,duration_ms,error_message,created_at").eq("scan_id", scan.id).order("created_at"),
      sb.from("ai_runs").select("purpose,model,status,duration_ms,error_message,input_tokens,output_tokens,created_at").eq("workspace_id", member.workspace_id).order("created_at", { ascending: false }).limit(10),
      sb.from("scan_reports").select("ai_status,ai_error,ai_latency_ms,model,summary,created_at").eq("scan_id", scan.id).maybeSingle(),
      sb.from("scan_findings").select("id", { count: "exact", head: true }).eq("scan_id", scan.id),
      sb.from("finding_evidence").select("id", { count: "exact", head: true }).eq("scan_id", scan.id),
      sb.from("security_events").select("category,event_type,severity,message,created_at").eq("scan_id", scan.id).order("created_at", { ascending: false }),
    ]);
    return {
      scan,
      stages: stages.data ?? [],
      sources: sources.data ?? [],
      ai: ai.data ?? [],
      report: report.data ?? null,
      findingCount: findings.count ?? 0,
      evidenceCount: evidence.count ?? 0,
      security: security.data ?? [],
    };
  });
