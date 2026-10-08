// Evaluates the workspace's stored alert rules against real review data and
// records any new alerts. No sample data: every signal comes from stored reviews.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type Ctx = import("./backend-types").AuthContext;

async function workspaceIdFor(context: Ctx) {
  const { data, error } = await context.supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", context.userId)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("No workspace is assigned to this account.");
  return data.workspace_id as string;
}

const DAY = 86_400_000;

/** Runs the unanswered / rating-drop / volume-spike rules and inserts missing alerts. */
export const evaluateAlertRules = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const workspaceId = await workspaceIdFor(context);

    const { data: rules } = await context.supabase
      .from("alert_rules")
      .select(
        "negative_rating_threshold, unanswered_hours, rating_drop_threshold, volume_spike_percent",
      )
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    const negativeThreshold = rules?.negative_rating_threshold ?? 2;
    const unansweredHours = rules?.unanswered_hours ?? 24;
    const dropThreshold = Number(rules?.rating_drop_threshold ?? 0.3);
    const spikePercent = rules?.volume_spike_percent ?? 100;

    const since = new Date(Date.now() - 60 * DAY).toISOString();
    const { data: reviews, error } = await context.supabase
      .from("reviews")
      .select("id, rating, status, reply, location_name, body, external_created_at")
      .eq("workspace_id", workspaceId)
      .neq("source", "seed")
      .gte("external_created_at", since)
      .order("external_created_at", { ascending: false });
    if (error) throw error;

    const rows = (reviews ?? []) as Array<{
      id: string;
      rating: number;
      status: string;
      reply: string | null;
      location_name: string;
      body: string;
      external_created_at: string;
    }>;

    const { data: existing } = await context.supabase
      .from("alerts")
      .select("id, kind, review_id, created_at, resolved")
      .eq("workspace_id", workspaceId)
      .eq("resolved", false);
    const openAlerts = (existing ?? []) as Array<{
      kind: string;
      review_id: string | null;
      created_at: string;
    }>;
    const hasOpenFor = (kind: string, reviewId: string) =>
      openAlerts.some((a) => a.kind === kind && a.review_id === reviewId);
    const hasRecent = (kind: string) =>
      openAlerts.some((a) => a.kind === kind && Date.now() - Date.parse(a.created_at) < DAY);

    const pending: Array<{
      workspace_id: string;
      review_id?: string;
      kind: string;
      severity: string;
      title: string;
      detail: string;
      location_name: string;
    }> = [];

    // 1. Negative reviews left unanswered beyond the configured window.
    const cutoff = Date.now() - unansweredHours * 3_600_000;
    for (const r of rows) {
      if (r.rating > negativeThreshold) continue;
      if (r.status === "replied" || r.reply) continue;
      if (Date.parse(r.external_created_at) > cutoff) continue;
      if (hasOpenFor("unresolved", r.id)) continue;
      pending.push({
        workspace_id: workspaceId,
        review_id: r.id,
        kind: "unresolved",
        severity: r.rating <= 1 ? "critical" : "high",
        title: `${r.rating}-star review unanswered for over ${unansweredHours}h`,
        detail: r.body.slice(0, 240),
        location_name: r.location_name,
      });
    }

    // 2. Rating drop over the last 30 days versus the 30 before.
    const now = Date.now();
    const recent = rows.filter((r) => now - Date.parse(r.external_created_at) <= 30 * DAY);
    const prior = rows.filter((r) => {
      const age = now - Date.parse(r.external_created_at);
      return age > 30 * DAY && age <= 60 * DAY;
    });
    const avg = (list: typeof rows) => list.reduce((s, r) => s + r.rating, 0) / list.length;
    if (recent.length >= 5 && prior.length >= 5) {
      const delta = avg(prior) - avg(recent);
      if (delta >= dropThreshold && !hasRecent("rating_drop")) {
        pending.push({
          workspace_id: workspaceId,
          kind: "rating_drop",
          severity: delta >= dropThreshold * 2 ? "critical" : "high",
          title: `Average rating fell ${delta.toFixed(2)} stars in 30 days`,
          detail: `Last 30 days average ${avg(recent).toFixed(2)} from ${recent.length} reviews, against ${avg(prior).toFixed(2)} from ${prior.length} reviews in the previous 30 days.`,
          location_name: "All locations",
        });
      }
    }

    // 3. Unusual review volume in the last 7 days versus the 7 before.
    const week = rows.filter((r) => now - Date.parse(r.external_created_at) <= 7 * DAY).length;
    const priorWeek = rows.filter((r) => {
      const age = now - Date.parse(r.external_created_at);
      return age > 7 * DAY && age <= 14 * DAY;
    }).length;
    if (priorWeek >= 3 && week > priorWeek) {
      const change = Math.round(((week - priorWeek) / priorWeek) * 100);
      if (change >= spikePercent && !hasRecent("volume_spike")) {
        pending.push({
          workspace_id: workspaceId,
          kind: "volume_spike",
          severity: "medium",
          title: `Review volume up ${change}% this week`,
          detail: `${week} reviews in the last 7 days against ${priorWeek} in the 7 days before. Check for a campaign, an incident or coordinated posting.`,
          location_name: "All locations",
        });
      }
    }

    if (pending.length === 0) return { created: 0 };
    const { error: insertError } = await context.supabase.from("alerts").insert(pending);
    if (insertError) throw insertError;
    return { created: pending.length };
  });
