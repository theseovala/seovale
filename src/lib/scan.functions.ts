// Client-facing scan API. Everything returned here comes from stored scan data
// produced by real network calls — no value is generated for display purposes.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type Ctx = { supabase: any; userId: string };

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

export const createScan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ url: z.string().min(3).max(2000) }).parse(input))
  .handler(async ({ data, context }) => {
    const member = await workspace(context as Ctx);
    const { normalizeTarget, assertPublicTarget } = await import("@/lib/scan/collectors.server");
    const target = normalizeTarget(data.url);
    // SSRF guard: reject internal, private or metadata addresses before anything is queued.
    try {
      await assertPublicTarget(target.url);
    } catch (blocked) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { recordSecurityEvent } = await import("@/lib/ops.server");
      await recordSecurityEvent(supabaseAdmin, {
        workspaceId: member.workspace_id,
        actor: (context as Ctx).userId,
        category: "crawler",
        eventType: "blocked_target",
        severity: "warning",
        message: blocked instanceof Error ? blocked.message : "Blocked scan target.",
        metadata: { target: target.url },
      });
      throw blocked;
    }
    // Double-click guard: an active scan for the same address is reused instead of duplicated.
    const { data: active } = await (context as Ctx).supabase
      .from("scans")
      .select("id,target_url,target_domain")
      .eq("workspace_id", member.workspace_id)
      .eq("target_domain", target.domain)
      .in("status", ["queued", "running", "retrying"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (active) return { id: active.id as string, url: active.target_url as string, domain: active.target_domain as string, reused: true };
    const { data: row, error } = await (context as Ctx).supabase
      .from("scans")
      .insert({
        workspace_id: member.workspace_id,
        requested_by: (context as Ctx).userId,
        target_url: target.url,
        target_domain: target.domain,
        status: "queued",
      })
      .select("id")
      .single();
    if (error) throw error;
    return { id: row.id as string, url: target.url, domain: target.domain, reused: false };
  });

/** Runs a queued scan. Long-running, so the UI starts it and then polls. */
export const runScanNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: scan, error } = await (context as Ctx).supabase.from("scans").select("id,status").eq("id", data.id).single();
    if (error) throw error;
    if (!scan) throw new Error("Scan not found.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { runScan } = await import("@/lib/scan/engine.server");
    try {
      return await runScan(supabaseAdmin, data.id);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      await supabaseAdmin.from("scans").update({ status: "failed", error_message: message.slice(0, 500), completed_at: new Date().toISOString() }).eq("id", data.id);
      throw caught;
    }
  });

export const cancelScan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await (context as Ctx).supabase
      .from("scans")
      .update({ status: "cancelled", completed_at: new Date().toISOString() })
      .eq("id", data.id)
      .in("status", ["queued", "running"]);
    if (error) throw error;
    return { ok: true };
  });

/**
 * Data lifecycle: removes one scan and everything derived from it. Related
 * layers are deleted explicitly so nothing unrelated is touched.
 */
/** Pause: the engine checks the stored status between stages and stops cooperatively. */
export const pauseScan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await (context as Ctx).supabase
      .from("scans")
      .update({ status: "paused" })
      .eq("id", data.id)
      .in("status", ["queued", "running", "retrying"])
      .select("id");
    if (error) throw error;
    if (!rows?.length) throw new Error("This scan is not running, so it cannot be paused.");
    return { ok: true };
  });

/** Resume/retry both re-enter the engine, which skips sources already collected. */
export const resumeScan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const supabase = (context as Ctx).supabase;
    const { data: scan, error } = await supabase.from("scans").select("id,status,attempts,max_attempts").eq("id", data.id).single();
    if (error) throw error;
    if (!["paused", "failed", "cancelled"].includes(scan.status)) throw new Error("Only a paused, failed or cancelled scan can be resumed.");
    if (scan.max_attempts && scan.attempts >= scan.max_attempts) throw new Error("This scan reached its maximum number of attempts.");
    await supabase.from("scans").update({ status: "retrying", error_message: null, completed_at: null }).eq("id", data.id);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { runScan } = await import("@/lib/scan/engine.server");
    try {
      return await runScan(supabaseAdmin, data.id);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      await supabaseAdmin
        .from("scans")
        .update({ status: "failed", error_message: message.slice(0, 500), completed_at: new Date().toISOString() })
        .eq("id", data.id);
      throw caught;
    }
  });

export const deleteScan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const supabase = (context as Ctx).supabase;
    // RLS check first: the caller must be able to see this scan.
    const { data: scan, error } = await supabase.from("scans").select("id,workspace_id").eq("id", data.id).single();
    if (error) throw error;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // finding_evidence cascades with its finding; business_facts and
    // data_conflicts survive on purpose — they belong to the business, not to
    // one scan, and their scan link is cleared by the foreign key.
    const derived = ["finding_evidence", "scan_findings", "scan_metrics", "scan_sources", "scan_reports", "provider_raw_data"] as const;
    for (const table of derived) {
      await supabaseAdmin.from(table).delete().eq("scan_id", scan.id);
    }
    await supabaseAdmin.from("scans").delete().eq("id", scan.id);
    await supabaseAdmin.from("audit_logs").insert({
      workspace_id: scan.workspace_id,
      action: "scan.deleted",
      target_type: "scan",
      target_id: scan.id,
      metadata: { requested_by: (context as Ctx).userId },
    });
    return { ok: true };
  });

export const listScans = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await (context as Ctx).supabase
      .from("scans")
      .select("id,target_url,target_domain,status,score,duration_ms,error_message,created_at,completed_at")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    return data ?? [];
  });

export const getScan = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const supabase = (context as Ctx).supabase;
    const { data: scan, error } = await supabase
      .from("scans")
      .select("id,target_url,target_domain,status,score,duration_ms,error_message,created_at,started_at,completed_at")
      .eq("id", data.id)
      .single();
    if (error) throw error;

    const [sources, metrics, findings, report, stages, facts, conflicts, evidence] = await Promise.all([
      supabase.from("scan_sources").select("source,provider,status,http_status,duration_ms,error_message,created_at").eq("scan_id", data.id).order("source"),
      supabase.from("scan_metrics").select("category,metric_key,value_numeric,value_text,unit,source").eq("scan_id", data.id).order("category"),
      supabase.from("scan_findings").select("id,category,code,severity,title,detail,recommendation,impact,evidence,source,created_at,confidence,priority_score,priority_rank,status,change_state").eq("scan_id", data.id).order("priority_rank", { ascending: true, nullsFirst: false }),
      supabase.from("scan_reports").select("score,category_scores,summary,model,created_at,sections,action_plan,historical,ai_status,ai_error,ai_latency_ms").eq("scan_id", data.id).maybeSingle(),

      supabase.from("scan_stages").select("stage,label,position,status,detail,started_at,completed_at").eq("scan_id", data.id).order("position"),
      supabase
        .from("business_facts")
        .select("field_key,value_normalized,value_raw,source_provider,source_type,source_url,confidence,retrieved_at,last_verified_at,previous_value,changed_at")
        .eq("domain", scan.target_domain)
        .order("field_key"),
      supabase
        .from("data_conflicts")
        .select("field_key,source_a,value_a,observed_a_at,source_b,value_b,observed_b_at,status,detected_at,resolved_at")
        .eq("domain", scan.target_domain)
        .order("detected_at", { ascending: false }),
      supabase
        .from("finding_evidence")
        .select("finding_id,source,source_type,reference,value,observed_at")
        .eq("scan_id", data.id)
        .order("observed_at"),
    ]);

    // Evidence is keyed by finding code so screen, report and CSV read the same rows.
    const evidenceByCode = new Map<string, { source: string; sourceType: string; reference: string | null; value: string; observedAt: string }[]>();
    for (const row of (evidence.data ?? []) as any[]) {
      const list = evidenceByCode.get(row.reference) ?? [];
      list.push({ source: row.source, sourceType: row.source_type, reference: row.reference, value: row.value, observedAt: row.observed_at });
      evidenceByCode.set(row.reference, list);
    }

    const { freshnessOf } = await import("@/lib/scan/engine.server");
    const sourceRows = (sources.data ?? []).map((row: any) => ({ ...row, freshness: freshnessOf(row.source, row.created_at) }));

    // Historical comparison against the previous completed scan of the same domain.
    const { data: previous } = await supabase
      .from("scans")
      .select("id,score,created_at")
      .eq("target_domain", scan.target_domain)
      .in("status", ["completed", "completed_with_warnings"])
      .lt("created_at", scan.created_at)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();


    let comparison: null | {
      previousScanId: string;
      previousScore: number | null;
      previousAt: string;
      resolved: { code: string; title: string }[];
      introduced: { code: string; title: string }[];
      unchanged: number;
    } = null;
    if (previous) {
      const { data: previousFindings } = await supabase.from("scan_findings").select("code,title").eq("scan_id", previous.id);
      const before = new Map<string, string>((previousFindings ?? []).map((f: any) => [String(f.code), String(f.title)]));
      const now = new Map<string, string>((findings.data ?? []).map((f: any) => [String(f.code), String(f.title)]));
      comparison = {
        previousScanId: previous.id,
        previousScore: previous.score,
        previousAt: previous.created_at,
        resolved: Array.from(before.entries()).filter(([code]) => !now.has(code)).map(([code, title]) => ({ code, title })),
        introduced: Array.from(now.entries()).filter(([code]) => !before.has(code)).map(([code, title]) => ({ code, title })),
        unchanged: Array.from(now.keys()).filter((code) => before.has(code)).length,
      };
    }

    return {
      scan,
      sources: sourceRows,
      metrics: metrics.data ?? [],
      findings: (findings.data ?? []).map((row: any) => ({ ...row, evidenceRecords: evidenceByCode.get(row.code) ?? [] })),
      facts: facts.data ?? [],
      conflicts: conflicts.data ?? [],
      report: report.data ?? null,
      stages: stages.data ?? [],
      comparison,
    };
  });

const csvCell = (value: unknown) => {
  const text = value === null || value === undefined || value === "" ? "DATA NOT AVAILABLE" : String(value);
  return `"${text.replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
};

/** CSV built strictly from stored scan rows. */
export const exportScanCsv = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const supabase = (context as Ctx).supabase;
    const { data: scan, error } = await supabase.from("scans").select("target_url,target_domain,status,score,created_at,completed_at").eq("id", data.id).single();
    if (error) throw error;
    const [findings, metrics, sources] = await Promise.all([
      supabase
        .from("scan_findings")
        .select("category,code,severity,title,detail,recommendation,impact,evidence,source,created_at,confidence,priority_rank,priority_score,status,change_state")
        .eq("scan_id", data.id)
        .order("priority_rank", { ascending: true, nullsFirst: false }),
      supabase.from("scan_metrics").select("category,metric_key,value_numeric,value_text,unit,source").eq("scan_id", data.id),
      supabase.from("scan_sources").select("source,provider,status,http_status,duration_ms,error_message,created_at").eq("scan_id", data.id),
    ]);

    const lines: string[] = [];
    const header = [
      "Section",
      "Category",
      "Key",
      "Severity",
      "Priority",
      "Confidence",
      "Status",
      "Change",
      "Value",
      "Detail",
      "Recommendation",
      "Evidence",
      "Source",
      "Retrieved at",
    ];
    const row = (cells: unknown[]) => lines.push(cells.map(csvCell).join(","));

    lines.push(header.map(csvCell).join(","));
    row(["Scan", "target", "url", "", "", "", scan.status, "", scan.target_url, `Status: ${scan.status}`, "", "", "scan", scan.created_at]);
    row(["Scan", "target", "score", "", "", "", "", "", scan.score ?? "", "0-100, derived from measured findings", "", "", "scan", scan.completed_at ?? ""]);
    for (const source of sources.data ?? []) {
      row([
        "Source",
        "health",
        source.source,
        "",
        "",
        "",
        source.status,
        "",
        source.status,
        source.error_message ?? `HTTP ${source.http_status ?? ""} in ${source.duration_ms ?? ""}ms`,
        "",
        "",
        source.provider ?? "website",
        source.created_at,
      ]);
    }
    for (const metric of metrics.data ?? []) {
      row([
        "Measurement",
        metric.category,
        metric.metric_key,
        "",
        "",
        "",
        "",
        "",
        metric.value_numeric ?? metric.value_text,
        metric.unit ?? "",
        "",
        "",
        metric.source,
        scan.completed_at ?? "",
      ]);
    }
    for (const finding of findings.data ?? []) {
      row([
        "Finding",
        finding.category,
        finding.code,
        finding.severity,
        finding.priority_rank ?? "",
        finding.confidence ?? "",
        finding.status ?? "",
        finding.change_state ?? "",
        finding.title,
        finding.detail,
        finding.recommendation ?? "",
        JSON.stringify(finding.evidence ?? {}),
        finding.source,
        (finding.evidence as any)?.collectedAt ?? finding.created_at,
      ]);
    }
    return { filename: `seovale-scan-${scan.target_domain}-${new Date(scan.created_at).toISOString().slice(0, 10)}.csv`, csv: lines.join("\n") };
  });


/**
 * Finding triage. The status is stored on the finding row itself, scoped to the
 * caller's workspace, so the report, filters and CSV all read the same value.
 */
export const setFindingStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        findingId: z.string().uuid(),
        status: z.enum(["open", "acknowledged", "resolved", "ignored", "recheck_required"]),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const member = await workspace(context as Ctx);
    const { data: finding, error: readError } = await context.supabase
      .from("scan_findings")
      .select("id, scan_id, scans!inner(workspace_id)")
      .eq("id", data.findingId)
      .maybeSingle();
    if (readError) throw new Error(readError.message);
    if (!finding || finding.scans?.workspace_id !== member.workspace_id) {
      throw new Error("Finding not found.");
    }
    // Findings are read-only for members under RLS, so the write happens with the
    // service role only after the ownership check above has passed.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error, count } = await supabaseAdmin
      .from("scan_findings")
      .update({ status: data.status }, { count: "exact" })
      .eq("id", data.findingId);
    if (error) throw new Error(error.message);
    if (!count) throw new Error("Finding could not be updated.");
    return { ok: true, status: data.status };
  });
