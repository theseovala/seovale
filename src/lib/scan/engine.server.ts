// Scan orchestrator. Owns the complete lifecycle of one scan:
//
//   validate → platform discovery → parallel collection → website crawl →
//   normalization → cross-source validation → analysis → AI → report
//
// Layers stay separated: scan_sources (RAW) → scan_metrics (NORMALIZED) →
// scan_findings (ANALYSIS) → scan_reports (REPORT). Nothing is invented: a
// source that fails, is not configured or needs sign-in is recorded as such,
// and one provider failing never fails the whole scan.
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  collectCrawl,
  collectCrawlDirectives,
  collectDns,
  collectPage,
  collectPageSpeed,
  collectRdap,
  collectTls,
  extractIdentity,
  normalizeTarget,
  type SourceResult,
} from "./collectors.server";
import { analyze } from "./analyze.server";
import { discoverPlatforms, type PlatformDiscovery } from "./discovery.server";
import {
  ensureBusiness,
  recordEvidence,
  reconcileConflicts,
  upsertFacts,
  type Confidence,
  type FactInput,
} from "./canonical.server";

/** How long a collected source stays valid for incremental re-use, per source. */
export const FRESHNESS_MINUTES: Record<string, number> = {
  http: 60,
  tls: 720,
  dns: 360,
  rdap: 1440,
  crawl_directives: 720,
  pagespeed: 720,
  crawl: 360,
};

export function freshnessOf(source: string, collectedAt: string | null) {
  if (!collectedAt) return "unavailable" as const;
  const ttl = (FRESHNESS_MINUTES[source] ?? 720) * 60_000;
  const age = Date.now() - new Date(collectedAt).getTime();
  if (age <= ttl) return "fresh" as const;
  if (age <= ttl * 3) return "stale" as const;
  return "expired" as const;
}

async function audit(admin: SupabaseClient, workspaceId: string, action: string, scanId: string, metadata: Record<string, unknown> = {}) {
  await admin.from("audit_logs").insert({ workspace_id: workspaceId, action, target_type: "scan", target_id: scanId, metadata });
}

/** Google API key for PageSpeed: credential vault first, server environment as fallback. */
async function pagespeedKey(admin: SupabaseClient, workspaceId: string) {
  try {
    const { loadProviderCredentials } = await import("@/lib/integrations/credentials.server");
    const bag = await loadProviderCredentials(admin, workspaceId, "google_maps");
    const fromVault = bag["GOOGLE_MAPS_API_KEY"] ?? bag["GOOGLE_API_KEY"];
    if (fromVault) return fromVault;
  } catch {
    // Vault unavailable — fall through to the environment.
  }
  return process.env["GOOGLE_API_KEY"] ?? null;
}

export interface RunScanResult {
  status: "completed" | "completed_with_warnings" | "failed";
  score: number | null;
  findings: number;
  sources: { source: string; status: string; reused: boolean }[];
}

/** Stage plan — each entry is a real unit of work the engine performs. */
const STAGE_PLAN: { stage: string; label: string }[] = [
  { stage: "validate", label: "Address validated" },
  { stage: "discover", label: "Platforms discovered and connections verified" },
  { stage: "collect", label: "Website and technical data collected" },
  { stage: "crawl", label: "Website pages crawled" },
  { stage: "normalize", label: "Data normalized and stored" },
  { stage: "cross_validate", label: "Business details compared across sources" },
  { stage: "analyze", label: "Technical checks and findings generated" },
  { stage: "ai", label: "AI analysis completed" },
  { stage: "report", label: "Report generated and stored" },
];

async function seedStages(admin: SupabaseClient, scanId: string, workspaceId: string) {
  await admin.from("scan_stages").upsert(
    STAGE_PLAN.map((item, index) => ({
      scan_id: scanId,
      workspace_id: workspaceId,
      stage: item.stage,
      label: item.label,
      position: index,
    })),
    { onConflict: "scan_id,stage" },
  );
}

async function stage(
  admin: SupabaseClient,
  scanId: string,
  name: string,
  status: "running" | "completed" | "failed" | "skipped",
  detail?: string | null,
) {
  const patch: Record<string, unknown> = { status, detail: detail ?? null };
  if (status === "running") patch["started_at"] = new Date().toISOString();
  else patch["completed_at"] = new Date().toISOString();
  await admin.from("scan_stages").update(patch).eq("scan_id", scanId).eq("stage", name);
}

/** Cooperative stop: the engine checks the stored status between stages. */
async function stopRequested(admin: SupabaseClient, scanId: string) {
  const { data } = await admin.from("scans").select("status").eq("id", scanId).maybeSingle();
  return data?.status === "paused" || data?.status === "cancelled" ? (data.status as string) : null;
}

/**
 * Postgres `jsonb` cannot hold a NUL character, and real pages do contain them.
 * Without this the whole row is rejected with 22P05 and the source silently
 * disappears — which then looks like "the website could not be loaded" and
 * produces findings that are not true. Strip the character, keep the content.
 */
function jsonbSafe<T>(value: T): T {
  if (typeof value === "string") return value.replace(/\u0000/g, "") as unknown as T;
  if (Array.isArray(value)) return value.map(jsonbSafe) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key.replace(/\u0000/g, "")] = jsonbSafe(item);
    return out as unknown as T;
  }
  return value;
}

async function storeSource(admin: SupabaseClient, scanId: string, workspaceId: string, result: SourceResult, domain: string) {
  const raw = jsonbSafe(result.raw);
  // The error is inspected, never discarded: a source that cannot be stored is
  // recorded as a failed source instead of vanishing from the scan.
  const { error: storeError } = await admin.from("scan_sources").upsert(
    {
      scan_id: scanId,
      workspace_id: workspaceId,
      source: result.source,
      provider: result.provider ?? null,
      status: result.status,
      http_status: result.httpStatus ?? null,
      duration_ms: result.durationMs,
      error_message: result.errorMessage ?? null,
      raw: raw as any,
      created_at: new Date().toISOString(),
    },
    { onConflict: "scan_id,source" },
  );
  if (storeError) {
    await admin.from("scan_sources").upsert(
      {
        scan_id: scanId,
        workspace_id: workspaceId,
        source: result.source,
        provider: result.provider ?? null,
        status: "failed",
        http_status: result.httpStatus ?? null,
        duration_ms: result.durationMs,
        error_message: `The collected payload could not be stored: ${storeError.message}`.slice(0, 500),
        raw: {},
        created_at: new Date().toISOString(),
      },
      { onConflict: "scan_id,source" },
    );
  }
  if (result.provider) {
    await admin.from("provider_raw_data").insert({
      workspace_id: workspaceId,
      provider: result.provider,
      resource_type: result.source,
      external_id: domain,
      scan_id: scanId,
      payload: raw as any,
    });
  }
  await admin.from("integration_api_logs").insert({
    workspace_id: workspaceId,
    provider: result.provider ?? "website",
    operation: `scan.${result.source}`,
    method: "GET",
    endpoint: domain,
    http_status: result.httpStatus ?? null,
    duration_ms: result.durationMs,
    outcome_code:
      result.status === "completed" ? "CONNECTED" : result.status === "not_configured" ? "NOT_CONFIGURED" : "PROVIDER_ERROR",
    error_message: result.errorMessage ?? null,
  });
}

/** Discovery outcome → the honest scan_sources status for that platform. */
function discoveryStatus(item: PlatformDiscovery): SourceResult["status"] | "auth_required" | "not_supported" | "unavailable" | "approval_required" {
  switch (item.status) {
    case "connected":
      return "completed";
    case "auth_required":
      return "auth_required";
    case "approval_required":
      return "approval_required";
    case "not_supported":
      return "not_supported";
    case "unavailable":
      return "unavailable";
    case "failed":
      return "failed";
    default:
      return "not_configured";
  }
}

/** Compares what the website publishes with what connected platforms confirm. */
function crossValidate(identity: ReturnType<typeof extractIdentity>, discovery: PlatformDiscovery[]) {
  const findings: {
    category: string;
    code: string;
    severity: "critical" | "high" | "medium" | "low" | "info";
    title: string;
    detail: string;
    recommendation: string | null;
    impact: number;
    evidence: Record<string, unknown>;
    source: string;
  }[] = [];

  const fields: { key: string; label: string; value: string | null }[] = [
    { key: "name", label: "Business name", value: identity.name },
    { key: "phone", label: "Phone number", value: identity.phone },
    { key: "address", label: "Address", value: identity.address },
    { key: "category", label: "Business category", value: identity.category },
  ];
  for (const field of fields) {
    if (!field.value) {
      findings.push({
        category: "consistency",
        code: `identity_missing_${field.key}`,
        severity: field.key === "name" ? "medium" : "low",
        title: `${field.label} is not published on the website`,
        detail: `MISSING — the website does not state its ${field.label.toLowerCase()} in a machine-readable way, so search engines and directories cannot verify it.`,
        recommendation: `Add the ${field.label.toLowerCase()} to the site's structured data (schema.org).`,
        impact: field.key === "name" ? 4 : 2,
        evidence: { status: "MISSING", field: field.key },
        source: "crawl",
      });
    }
  }

  const linked = discovery.filter((item) => Array.isArray((item.evidence as any).profileLinks));
  for (const item of linked) {
    const profileLinks = (item.evidence as any).profileLinks as string[];
    const declaredInSchema = profileLinks.some((link) => identity.sameAs.some((same) => same.includes(new URL(link).hostname)));
    const verified = item.status === "connected";
    findings.push({
      category: "consistency",
      code: `cross_source_${item.provider}`,
      severity: verified ? "info" : "low",
      title: `${item.label} profile linked from the website`,
      detail: verified
        ? `MATCH — the website links to ${item.label} and the connected account confirms access.`
        : `UNVERIFIED — the website links to ${item.label}, but that account is not connected here, so its details cannot be compared. ${item.detail}`,
      recommendation: verified ? null : `Connect ${item.label} in the integration manager to verify these details automatically.`,
      impact: verified ? 0 : 1,
      evidence: { status: verified ? "MATCH" : "UNVERIFIED", profileLinks, declaredInSchema, connection: item.status },
      source: "cross_source",
    });
  }

  const connectedNotLinked = discovery.filter(
    (item) => item.status === "connected" && !Array.isArray((item.evidence as any).profileLinks),
  );
  for (const item of connectedNotLinked) {
    findings.push({
      category: "consistency",
      code: `cross_source_unlinked_${item.provider}`,
      severity: "low",
      title: `${item.label} is connected but not linked from the website`,
      detail: `MISMATCH — the ${item.label} account is connected here, but the website does not link to that profile, so visitors and search engines cannot connect the two.`,
      recommendation: `Add the ${item.label} profile link to the website footer and to the site's structured data.`,
      impact: 2,
      evidence: { status: "MISMATCH", connection: item.status },
      source: "cross_source",
    });
  }

  return findings;
}

/** Facts the collectors actually observed, each tagged with its own source. */
function collectFacts(
  identity: ReturnType<typeof extractIdentity>,
  html: string,
  finalUrl: string | null,
  tlsRaw: Record<string, unknown> | null,
  rdapRaw: Record<string, unknown> | null,
  observedAt: string,
) {
  const facts: FactInput[] = [];
  const push = (
    fieldKey: string,
    value: unknown,
    sourceProvider: string,
    sourceType: string,
    confidence: Confidence,
    sourceUrl?: string | null,
  ) => {
    if (typeof value !== "string" || !value.trim()) return;
    facts.push({ fieldKey, value: value.trim(), sourceProvider, sourceType, confidence, observedAt, sourceUrl: sourceUrl ?? finalUrl });
  };

  // Source 1: schema.org structured data published by the site.
  push("name", identity.name, "website_schema", "structured_data", "high");
  push("phone", identity.phone, "website_schema", "structured_data", "high");
  push("address", identity.address, "website_schema", "structured_data", "high");
  push("category", identity.category, "website_schema", "structured_data", "medium");
  push("website", identity.website, "website_schema", "structured_data", "high");

  // Source 2: the rendered page itself — an independent view of the same facts.
  push("title", html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " "), "website_html", "page_markup", "verified");
  push(
    "meta_description",
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1],
    "website_html",
    "page_markup",
    "verified",
  );
  push("canonical", html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1], "website_html", "page_markup", "verified");
  push("phone", html.match(/href=["']tel:([^"']+)["']/i)?.[1], "website_html", "page_markup", "medium");
  push("website", finalUrl, "website_html", "http_response", "verified");

  // Source 3+: infrastructure observations.
  if (tlsRaw) push("ssl_issuer", (tlsRaw as any).issuer, "ssl", "certificate", "verified");
  if (rdapRaw) push("registrar", (rdapRaw as any).registrar, "rdap", "registry", "verified");
  return facts;
}

export async function runScan(admin: SupabaseClient, scanId: string): Promise<RunScanResult> {
  const { data: scan, error } = await admin
    .from("scans")
    .select("id,workspace_id,target_url,target_domain,status,attempts,max_attempts,created_at")
    .eq("id", scanId)
    .single();
  if (error) throw error;
  if (!scan) throw new Error("Scan not found.");
  if (scan.status === "completed" || scan.status === "completed_with_warnings" || scan.status === "cancelled") {
    return { status: "completed", score: null, findings: 0, sources: [] };
  }

  const started = Date.now();
  await admin
    .from("scans")
    .update({ status: "running", started_at: new Date().toISOString(), attempts: (scan.attempts ?? 0) + 1, error_message: null })
    .eq("id", scanId);
  await audit(admin, scan.workspace_id, "scan.started", scanId, { url: scan.target_url });
  await seedStages(admin, scanId, scan.workspace_id);

  await stage(admin, scanId, "validate", "running");
  const target = normalizeTarget(scan.target_url);
  await stage(admin, scanId, "validate", "completed", target.url);

  await stage(admin, scanId, "collect", "running");
  const key = await pagespeedKey(admin, scan.workspace_id);

  // Resume/incremental: sources already completed for this scan are not repeated.
  const { data: existing } = await admin.from("scan_sources").select("source,status,created_at").eq("scan_id", scanId);
  const done = new Map((existing ?? []).map((row: any) => [row.source, row]));
  const reusable = (source: string) => {
    const row = done.get(source);
    return Boolean(row && row.status === "completed" && freshnessOf(source, row.created_at) === "fresh");
  };

  const planned: { source: string; run: () => Promise<SourceResult> }[] = [
    { source: "http", run: () => collectPage(target.url) },
    { source: "tls", run: () => collectTls(target.origin) },
    { source: "dns", run: () => collectDns(target.domain) },
    { source: "rdap", run: () => collectRdap(target.domain) },
    { source: "crawl_directives", run: () => collectCrawlDirectives(target.origin) },
    { source: "pagespeed", run: () => collectPageSpeed(target.url, key) },
  ];

  const reused = planned.filter((item) => reusable(item.source)).map((item) => item.source);
  const toRun = planned.filter((item) => !reusable(item.source));

  // Independent sources run in parallel; one failing source never stops the scan.
  const collected = await Promise.all(
    toRun.map(async (item) => {
      try {
        return await item.run();
      } catch (caught) {
        return {
          source: item.source,
          provider: null,
          status: "failed" as const,
          durationMs: 0,
          errorMessage: caught instanceof Error ? caught.message : String(caught),
          raw: {},
        };
      }
    }),
  );
  for (const result of collected) await storeSource(admin, scanId, scan.workspace_id, result, target.domain);
  await stage(admin, scanId, "collect", "completed", `${collected.length} checked, ${reused.length} reused`);

  // ---------- HTML available from this run or from a reused row ----------
  const { data: httpRow } = await admin.from("scan_sources").select("raw").eq("scan_id", scanId).eq("source", "http").maybeSingle();
  const html = String((httpRow?.raw as any)?.html ?? "");
  const { data: directivesRow } = await admin
    .from("scan_sources")
    .select("raw")
    .eq("scan_id", scanId)
    .eq("source", "crawl_directives")
    .maybeSingle();
  const robotsText = ((directivesRow?.raw as any)?.robotsText ?? null) as string | null;

  // ---------- Platform discovery + connection verification ----------
  await stage(admin, scanId, "discover", "running");
  let discovery: PlatformDiscovery[] = [];
  try {
    discovery = await discoverPlatforms(admin, scan.workspace_id, html);
    for (const item of discovery) {
      await admin.from("scan_sources").upsert(
        {
          scan_id: scanId,
          workspace_id: scan.workspace_id,
          source: `platform:${item.provider}`,
          provider: item.provider,
          status: discoveryStatus(item),
          duration_ms: 0,
          error_message: item.status === "connected" ? null : item.detail.slice(0, 500),
          raw: { relevant: item.relevant, label: item.label, group: item.group, ...item.evidence } as any,
          created_at: new Date().toISOString(),
        },
        { onConflict: "scan_id,source" },
      );
    }
    const usable = discovery.filter((item) => item.status === "connected").length;
    const relevant = discovery.filter((item) => item.relevant).length;
    await stage(admin, scanId, "discover", "completed", `${discovery.length} platforms checked · ${relevant} relevant · ${usable} usable`);
  } catch (caught) {
    await stage(admin, scanId, "discover", "failed", caught instanceof Error ? caught.message.slice(0, 300) : String(caught));
  }

  // ---------- Website crawl ----------
  await stage(admin, scanId, "crawl", "running");
  if (reusable("crawl")) {
    reused.push("crawl");
    await stage(admin, scanId, "crawl", "completed", "Reused a fresh crawl from this scan");
  } else if (!html) {
    await stage(admin, scanId, "crawl", "skipped", "The start page could not be loaded, so no crawl was attempted.");
  } else {
    const crawl = await collectCrawl(target.url, robotsText);
    await storeSource(admin, scanId, scan.workspace_id, crawl, target.domain);
    await stage(
      admin,
      scanId,
      "crawl",
      crawl.status === "completed" ? "completed" : "failed",
      crawl.status === "completed" ? `${(crawl.raw as any).pagesCrawled} pages crawled` : crawl.errorMessage ?? null,
    );
  }

  await stage(admin, scanId, "normalize", "running");

  // Analysis runs over everything stored for this scan, reused rows included.
  const { data: allSources } = await admin
    .from("scan_sources")
    .select("source,provider,status,http_status,duration_ms,error_message,raw,created_at")
    .eq("scan_id", scanId);
  const sourceResults: SourceResult[] = (allSources ?? []).map((row: any) => ({
    source: row.source,
    provider: row.provider,
    status: row.status,
    httpStatus: row.http_status,
    durationMs: row.duration_ms ?? 0,
    errorMessage: row.error_message,
    raw: row.raw ?? {},
  }));

  await stage(admin, scanId, "normalize", "completed", `${sourceResults.length} sources stored`);

  const halt = await stopRequested(admin, scanId);
  if (halt) {
    await audit(admin, scan.workspace_id, `scan.${halt}`, scanId, {});
    return { status: "failed", score: null, findings: 0, sources: [] };
  }

  // ---------- Cross-source validation ----------
  await stage(admin, scanId, "cross_validate", "running");
  const identity = html ? extractIdentity(html) : { name: null, phone: null, address: null, website: null, category: null, sameAs: [] };
  const crossFindings = crossValidate(identity, discovery);

  // ---------- Canonical facts, change detection and source conflicts ----------
  const observedAt = new Date().toISOString();
  const tlsRaw = (sourceResults.find((s) => s.source === "tls")?.raw ?? null) as Record<string, unknown> | null;
  const rdapRaw = (sourceResults.find((s) => s.source === "rdap")?.raw ?? null) as Record<string, unknown> | null;
  const finalUrl = ((httpRow?.raw as any)?.finalUrl as string | null) ?? target.url;
  const facts = collectFacts(identity, html, finalUrl, tlsRaw, rdapRaw, observedAt);
  // Canonical business + domain record for this site (one per workspace/domain).
  const link = await ensureBusiness(admin, scan.workspace_id, {
    domain: scan.target_domain,
    url: finalUrl,
    name: identity.name,
    phone: identity.phone,
    address: identity.address,
    industry: identity.category,
    sslStatus:
      tlsRaw && "httpsReachable" in tlsRaw ? (tlsRaw["httpsReachable"] ? "valid" : "unreachable") : null,
    reachable: Boolean(httpRow),
    observedAt,
  });
  if (link) {
    await admin
      .from("scans")
      .update({ business_id: link.businessId, domain_id: link.domainId })
      .eq("id", scanId);
  }

  const factChanges = await upsertFacts(admin, scan.workspace_id, scan.target_domain, scanId, facts);
  const conflicts = await reconcileConflicts(admin, scan.workspace_id, scan.target_domain, scanId, facts);

  for (const conflict of conflicts) {
    crossFindings.push({
      category: "consistency",
      code: `conflict_${conflict.fieldKey}_${conflict.sourceA}_${conflict.sourceB}`,
      severity: "medium",
      title: `Sources disagree about the ${conflict.fieldKey.replace(/_/g, " ")}`,
      detail: `MISMATCH — ${conflict.sourceA} reports "${conflict.valueA}" while ${conflict.sourceB} reports "${conflict.valueB}". Neither value was chosen automatically.`,
      recommendation: "Decide which value is correct and publish the same value on every source.",
      impact: 3,
      evidence: {
        status: "MISMATCH",
        field: conflict.fieldKey,
        sourceA: conflict.sourceA,
        valueA: conflict.valueA,
        observedA: conflict.observedAAt,
        sourceB: conflict.sourceB,
        valueB: conflict.valueB,
        observedB: conflict.observedBAt,
      },
      source: "cross_source",
    });
  }
  for (const change of factChanges) {
    crossFindings.push({
      category: "consistency",
      code: `changed_${change.fieldKey}_${change.sourceProvider}`,
      severity: "info",
      title: `${change.fieldKey.replace(/_/g, " ")} changed since the previous scan`,
      detail: `CHANGED — ${change.sourceProvider} previously reported "${change.previous}" and now reports "${change.current}".`,
      recommendation: null,
      impact: 1,
      evidence: { status: "CHANGED", field: change.fieldKey, previous: change.previous, current: change.current, source: change.sourceProvider },
      source: "cross_source",
    });
  }

  await stage(
    admin,
    scanId,
    "cross_validate",
    "completed",
    `${facts.length} facts stored · ${conflicts.length} conflicts · ${factChanges.length} changes`,
  );

  await stage(admin, scanId, "analyze", "running");
  const pageFailed = sourceResults.find((s) => s.source === "http")?.status !== "completed";
  const { metrics, findings, score, categoryScores } = analyze(sourceResults);
  const allFindings = [...findings, ...crossFindings];

  const identityMetrics = Object.entries(identity)
    .filter(([, value]) => typeof value === "string" && value)
    .map(([metricKey, value]) => ({ category: "business", metricKey, valueText: String(value), source: "crawl" as const }));
  const normalizedMetrics = [...metrics, ...identityMetrics.map((m) => ({ ...m, valueNumeric: null, unit: null }))];

  if (normalizedMetrics.length) {
    await admin.from("scan_metrics").upsert(
      normalizedMetrics.map((metric) => ({
        scan_id: scanId,
        workspace_id: scan.workspace_id,
        category: metric.category,
        metric_key: metric.metricKey,
        value_numeric: metric.valueNumeric ?? null,
        value_text: metric.valueText ?? null,
        unit: metric.unit ?? null,
        source: metric.source,
      })),
      { onConflict: "scan_id,category,metric_key" },
    );
  }

  // ---------- History: what changed since the previous scan of this domain ----------
  const { data: previousScan } = await admin
    .from("scans")
    .select("id,score,created_at")
    .eq("target_domain", scan.target_domain)
    .in("status", ["completed", "completed_with_warnings"])
    .lt("created_at", scan.created_at)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let previousCodes = new Map<string, { severity: string; impact: number }>();
  if (previousScan) {
    const { data: previousFindings } = await admin.from("scan_findings").select("code,severity,impact").eq("scan_id", previousScan.id);
    previousCodes = new Map((previousFindings ?? []).map((row: any) => [String(row.code), { severity: row.severity, impact: row.impact ?? 0 }]));
  }
  const currentCodes = new Set(allFindings.map((finding) => finding.code));
  const resolvedIssues = Array.from(previousCodes.keys()).filter((code) => !currentCodes.has(code));
  const newIssues = allFindings.filter((finding) => !previousCodes.has(finding.code)).map((finding) => finding.code);

  // ---------- Deterministic priority ----------
  const { prioritize } = await import("./priority.server");
  const prioritizable = allFindings.map((finding) => ({
    code: finding.code,
    category: finding.category,
    severity: finding.severity,
    impact: finding.impact,
    source: finding.source,
    evidence: finding.evidence ?? null,
  }));
  const priorities = new Map(prioritize(prioritizable).map((item) => [item.code, item]));

  const detectedAt = new Date().toISOString();
  if (allFindings.length) {
    await admin.from("scan_findings").upsert(
      allFindings.map((finding) => {
        const priority = priorities.get(finding.code)!;
        const before = previousCodes.get(finding.code);
        const changeState = !previousScan ? "new" : !before ? "new" : before.severity !== finding.severity ? "changed" : "unchanged";
        return {
          scan_id: scanId,
          workspace_id: scan.workspace_id,
          category: finding.category,
          code: finding.code,
          severity: finding.severity,
          title: finding.title,
          detail: finding.detail,
          recommendation: finding.recommendation ?? null,
          impact: finding.impact,
          confidence: priority.confidence,
          priority_score: priority.priorityScore,
          priority_rank: priority.priorityRank,
          status: "open",
          change_state: changeState,
          evidence: {
            ...(finding.evidence ?? {}),
            source: finding.source,
            collectedAt: detectedAt,
            affectedCount: priority.affected,
            verification: finding.source === "cross_source" ? "compared" : "measured",
          },
          source: finding.source,
        };
      }),
      { onConflict: "scan_id,code" },
    );
  }

  // Evidence records are exploded from the findings that were actually stored,
  // so the report can never cite evidence the database does not hold.
  const { data: storedFindings } = await admin
    .from("scan_findings")
    .select("id,code,source,evidence")
    .eq("scan_id", scanId);
  const evidenceCount = await recordEvidence(
    admin,
    scan.workspace_id,
    scanId,
    (storedFindings ?? []).map((row: any) => ({ id: row.id, code: row.code, source: row.source, evidence: row.evidence ?? null })),
  );

  await stage(admin, scanId, "analyze", "completed", `${allFindings.length} findings prioritised · ${evidenceCount} evidence records`);
  await stage(admin, scanId, "ai", "running");

  // ---------- AI interpretation over validated data only ----------
  const { buildAiContext } = await import("./ai-context.server");
  const { analyseWithAi } = await import("./ai-analysis.server");
  const requestedBy = (await admin.from("scans").select("requested_by").eq("id", scanId).maybeSingle()).data?.requested_by ?? null;

  const aiContext = buildAiContext({
    url: target.url,
    domain: target.domain,
    scannedAt: detectedAt,
    score,
    identity: identity as Record<string, unknown>,
    sources: sourceResults.map((s) => ({ source: s.source, status: s.status, errorMessage: s.errorMessage ?? null, collectedAt: detectedAt })),
    platforms: discovery.map((item) => ({ provider: item.provider, status: item.status, relevant: item.relevant, detail: item.detail })),
    metrics: normalizedMetrics,
    findings: allFindings.map((finding) => {
      const priority = priorities.get(finding.code)!;
      return {
        code: finding.code,
        category: finding.category,
        severity: finding.severity,
        title: finding.title,
        detail: finding.detail,
        impact: finding.impact,
        source: finding.source,
        evidence: finding.evidence ?? null,
        confidence: priority.confidence,
        priorityRank: priority.priorityRank,
        affected: priority.affected,
      };
    }),
    history: previousScan
      ? {
          previousScanAt: previousScan.created_at,
          previousScore: previousScan.score,
          newIssues,
          resolvedIssues,
          unchanged: allFindings.length - newIssues.length,
        }
      : null,
  });

  const ai = await analyseWithAi(admin, scan.workspace_id, requestedBy, aiContext);
  if (ai.status === "failed") {
    await admin.from("scan_sources").upsert(
      {
        scan_id: scanId,
        workspace_id: scan.workspace_id,
        source: "ai_analysis",
        provider: "lovable_ai",
        status: "failed",
        duration_ms: ai.latencyMs,
        error_message: (ai.error ?? "AI analysis failed").slice(0, 500),
        raw: {},
        created_at: new Date().toISOString(),
      },
      { onConflict: "scan_id,source" },
    );
    await stage(admin, scanId, "ai", "failed", (ai.error ?? "AI analysis failed").slice(0, 300));
  } else {
    await admin.from("scan_sources").upsert(
      {
        scan_id: scanId,
        workspace_id: scan.workspace_id,
        source: "ai_analysis",
        provider: ai.provider,
        status: "completed",
        duration_ms: ai.latencyMs,
        error_message: null,
        raw: { model: ai.model, inputTokens: ai.inputTokens, outputTokens: ai.outputTokens, reused: ai.status === "reused" } as any,
        created_at: new Date().toISOString(),
      },
      { onConflict: "scan_id,source" },
    );
    await stage(admin, scanId, "ai", "completed", `${ai.model}${ai.status === "reused" ? " (reused, identical data)" : ""}`);
  }

  await stage(admin, scanId, "report", "running");

  // Report sections are derived from stored findings, so the report, the
  // screen and the CSV can never disagree.
  const severityCounts = allFindings.reduce<Record<string, number>>((counts, finding) => {
    counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
    return counts;
  }, {});
  const categoryCounts = allFindings.reduce<Record<string, number>>((counts, finding) => {
    counts[finding.category] = (counts[finding.category] ?? 0) + 1;
    return counts;
  }, {});

  await admin.from("scan_reports").upsert(
    {
      scan_id: scanId,
      workspace_id: scan.workspace_id,
      score,
      category_scores: categoryScores,
      summary: ai.analysis?.executiveSummary ?? null,
      model: ai.model,
      ai_status: ai.status === "failed" ? "failed" : "completed",
      ai_error: ai.error,
      ai_latency_ms: ai.latencyMs,
      ai_context_hash: ai.contextHash,
      action_plan: ai.analysis?.actionPlan ?? null,
      historical: {
        previousScanId: previousScan?.id ?? null,
        previousScanAt: previousScan?.created_at ?? null,
        previousScore: previousScan?.score ?? null,
        newIssues,
        resolvedIssues,
        unchanged: allFindings.length - newIssues.length,
        aiNote: ai.analysis?.historical ?? null,
      },
      sections: {
        condition: ai.analysis?.condition ?? "insufficient_evidence",
        categories: ai.analysis?.categories ?? [],
        crossSourceNotes: ai.analysis?.crossSourceNotes ?? [],
        severityCounts,
        categoryCounts,
        sourcesUsed: sourceResults.map((s) => ({ source: s.source, status: s.status })),
        unavailable: aiContext.unavailable,
      },
    },
    { onConflict: "scan_id" },
  );

  await stage(admin, scanId, "report", "completed", score === null ? "Report stored without a score" : `Score ${score}`);


  // ---------- Failure isolation ----------
  // Technical checks decide the outcome; a platform that is simply not
  // connected is information, not a failure.
  const technical = sourceResults.filter((s) => !s.source.startsWith("platform:"));
  const failedEverything = technical.every((s) => s.status !== "completed");
  const warnings = technical.filter((s) => s.status === "failed").map((s) => s.source);
  const status = failedEverything ? "failed" : warnings.length ? "completed_with_warnings" : "completed";
  await admin
    .from("scans")
    .update({
      status,
      score,
      duration_ms: Date.now() - started,
      completed_at: new Date().toISOString(),
      error_message: failedEverything
        ? "No data source could be reached for this address."
        : pageFailed
          ? "The website itself could not be loaded; other checks completed."
          : warnings.length
            ? `Completed, but these checks failed: ${warnings.join(", ")}.`
            : null,
    })
    .eq("id", scanId);

  await audit(admin, scan.workspace_id, `scan.${status}`, scanId, { score, findings: allFindings.length, reused, warnings });

  // Real notification from the actual outcome — no notification is written
  // unless the scan reached one of these terminal states.
  await admin.from("notifications").insert({
    workspace_id: scan.workspace_id,
    user_id: requestedBy,
    type: status === "failed" ? "scan_failed" : "scan_completed",
    severity: status === "failed" ? "critical" : status === "completed_with_warnings" ? "warning" : "success",
    title:
      status === "failed"
        ? `Scan failed for ${scan.target_domain}`
        : status === "completed_with_warnings"
          ? `Scan completed with warnings for ${scan.target_domain}`
          : `Scan completed for ${scan.target_domain}`,
    message:
      status === "failed"
        ? "No data source could be reached for this address."
        : `${score === null ? "Score unavailable" : `Score ${score}/100`} · ${allFindings.length} findings${warnings.length ? ` · failed checks: ${warnings.join(", ")}` : ""}`,
    entity_type: "scan",
    entity_id: scanId,
  });

  return {
    status,
    score,
    findings: allFindings.length,
    sources: sourceResults.map((s) => ({ source: s.source, status: s.status, reused: reused.includes(s.source) })),
  };
}
