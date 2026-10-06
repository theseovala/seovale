import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { createFileRoute, Link } from "@tanstack/react-router";
import { evaluateAlertRules } from "@/lib/alerts.functions";
import {
  ShieldAlert,
  TrendingDown,
  TrendingUp,
  Activity,
  Clock,
  ScanEye,
  BellOff,
  CheckCheck,
  RotateCcw,
} from "lucide-react";
import { AppShell } from "@/components/app/AppShell";
import { PageHeader, Section, StatCard, StatusBadge, EmptyState } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { type Alert } from "@/lib/domain";
import { useAlertRules, useLiveAlerts, useResolveAlert, useUpdateAlertRules } from "@/lib/seovale-db";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/_authenticated/alerts")({
  head: () => ({
    meta: [
      { title: "Reputation Alerts — Seovale" },
      {
        name: "description",
        content:
          "Alert center for negative reviews, rating drops, unusual activity, unresolved feedback and suspicious review patterns.",
      },
      { property: "og:title", content: "Reputation Alerts — Seovale" },
      { property: "og:description", content: "Know the moment your reputation needs attention." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AlertsPage,
});

const typeMeta: Record<Alert["type"], { icon: typeof ShieldAlert; label: string; tone: string }> = {
  negative: { icon: ShieldAlert, label: "Negative review", tone: "bg-negative-soft text-negative" },
  drop: { icon: TrendingDown, label: "Rating drop", tone: "bg-negative-soft text-negative" },
  spike: { icon: TrendingUp, label: "Reputation spike", tone: "bg-positive-soft text-positive" },
  unusual: { icon: Activity, label: "Unusual activity", tone: "bg-warning-soft text-rating-foreground" },
  unresolved: { icon: Clock, label: "Unresolved feedback", tone: "bg-warning-soft text-rating-foreground" },
  suspicious: { icon: ScanEye, label: "Suspicious activity", tone: "bg-info-soft text-info" },
};

const tabs = ["Unresolved", "All", "Resolved"] as const;
const severityFilters = ["all", "critical", "high", "medium", "info"] as const;
const typeFilters = ["all", ...Object.keys(typeMeta)] as const;

function AlertsPage() {
  const [tab, setTab] = useState<(typeof tabs)[number]>("Unresolved");
  const [severity, setSeverity] = useState<(typeof severityFilters)[number]>("all");
  const [type, setType] = useState<(typeof typeFilters)[number]>("all");
  const { data: alerts = [], isLoading } = useLiveAlerts();
  const resolve = useResolveAlert();
  const { data: rules } = useAlertRules();
  const updateRules = useUpdateAlertRules();
  const [rulesOpen, setRulesOpen] = useState(false);
  const [ruleForm, setRuleForm] = useState({ negative: 2, unanswered: 24, drop: 0.3, spike: 100 });
  const qc = useQueryClient();
  const evaluate = useServerFn(evaluateAlertRules);
  const evaluated = useRef(false);

  // Run the stored alert rules against live review data whenever the page opens.
  useEffect(() => {
    if (evaluated.current) return;
    evaluated.current = true;
    void evaluate({ data: undefined })
      .then((result) => {
        if (result?.created) void qc.invalidateQueries({ queryKey: ["alerts"] });
      })
      .catch(() => undefined);
  }, [evaluate, qc]);

  const list = alerts.filter((a) => {
    if (tab === "Resolved" && !a.resolved) return false;
    if (tab === "Unresolved" && a.resolved) return false;
    if (severity !== "all" && a.severity !== severity) return false;
    if (type !== "all" && a.type !== type) return false;
    return true;
  });

  const open = alerts.filter((a) => !a.resolved);
  const countBy = (s: Alert["severity"]) => open.filter((a) => a.severity === s).length;
  const resolvedCount = alerts.filter((a) => a.resolved).length;

  return (
    <AppShell>
      <PageHeader
        eyebrow="Prioritise"
        title="Reputation Alerts"
        description="Every signal that needs a human decision — ranked by impact, with a clear next action on each."
        actions={
          <>
            <Button variant="outline" onClick={() => {
              if (rules) setRuleForm({ negative: rules.negative_rating_threshold, unanswered: rules.unanswered_hours, drop: Number(rules.rating_drop_threshold), spike: rules.volume_spike_percent });
              setRulesOpen(true);
            }}><BellOff /> Alert rules</Button>
            <Button
              disabled={open.length === 0 || resolve.isPending}
              onClick={() => {
                const count = open.length;
                open.forEach((a) => resolve.mutate({ id: a.id, resolved: true }));
                toast.success(`${count} alerts resolved`);
              }}
            >
              <CheckCheck /> Resolve all
            </Button>
          </>
        }
      />

      <div className="stagger mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Critical" value={countBy("critical")} sub="Immediate action" icon={ShieldAlert} tone="negative" />
        <StatCard label="High" value={countBy("high")} sub="Within 4 hours" icon={TrendingDown} tone="rating" />
        <StatCard label="Medium" value={countBy("medium")} sub="Within 24 hours" icon={Clock} tone="default" />
        <StatCard label="Resolved" value={resolvedCount} sub="Closed in this workspace" icon={CheckCheck} tone="positive" />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-4">
        <div className="inline-flex rounded-lg border bg-card p-1">
          {tabs.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "rounded-md px-4 py-1.5 text-sm font-semibold transition-colors",
                tab === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
              )}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground">Severity:</span>
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value as typeof severity)}
            className="h-9 rounded-lg border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring/40"
          >
            {severityFilters.map((s) => (
              <option key={s} value={s}>{s === "all" ? "All" : s}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground">Type:</span>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as typeof type)}
            className="h-9 rounded-lg border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring/40"
          >
            {typeFilters.map((t) => (
              <option key={t} value={t}>{t === "all" ? "All" : typeMeta[t as Alert["type"]].label}</option>
            ))}
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="stagger grid gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton-shimmer h-24 rounded-xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <Section>
          <EmptyState icon={CheckCheck} title="No alerts here" description="Nothing to review in this view. Your monitoring rules are still watching every connected platform." />
        </Section>
      ) : (
        <div className="stagger grid gap-3">
          {list.map((a) => {
            const meta = typeMeta[a.type];
            return (
              <article
                key={a.id}
                className={cn(
                  "card-elevated card-interactive flex flex-col gap-4 p-5 md:flex-row md:items-center",
                  a.severity === "critical" && "border-l-4 border-l-negative",
                  a.resolved && "opacity-70",
                )}
              >
                <span className={cn("grid size-11 shrink-0 place-items-center rounded-xl", meta.tone)}>
                  <meta.icon className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-display text-base font-bold">{a.title}</h3>
                    <StatusBadge status={a.severity} />
                    <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{meta.label}</span>
                    {a.resolved && <StatusBadge status="Resolved" className="bg-positive-soft text-positive" />}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{a.detail}</p>
                  <p className="mt-1.5 text-xs text-muted-foreground">{a.location} · {a.time}</p>
                </div>
                <div className="flex flex-wrap gap-2 md:shrink-0">
                  <Button size="sm" asChild>
                    <Link to={a.type === "drop" || a.type === "spike" ? "/analytics" : "/reviews"}>
                      {a.type === "drop" || a.type === "spike" ? "Analyse" : a.type === "suspicious" ? "Review content" : "Open review"}
                    </Link>
                  </Button>
                  {a.resolved ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={resolve.isPending}
                      onClick={() =>
                        resolve.mutate(
                          { id: a.id, resolved: false },
                          {
                            onSuccess: () => toast.success("Alert reopened"),
                            onError: (e) => toast.error("Could not reopen alert", { description: (e as Error).message }),
                          },
                        )
                      }
                    >
                      <RotateCcw /> Reopen
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={resolve.isPending}
                      onClick={() =>
                        resolve.mutate(
                          { id: a.id, resolved: true },
                          {
                            onSuccess: () => toast.success("Alert resolved"),
                            onError: (e) => toast.error("Could not resolve alert", { description: (e as Error).message }),
                          },
                        )
                      }
                    >
                      Resolve
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <Section className="mt-5" title="How alerting works" description="Configure thresholds per location and platform">
        <div className="grid gap-4 md:grid-cols-3">
          {[
            ["Detect", "Continuous monitoring across every connected platform, location and keyword."],
            ["Rank", "Each signal is scored by rating impact, reviewer reach, recency and unresolved time."],
            ["Route", "Alerts are routed to the right teammate to action."],
          ].map(([t, d]) => (
            <div key={t} className="rounded-xl bg-muted/50 p-4">
              <p className="font-display text-sm font-bold text-primary">{t}</p>
              <p className="mt-1 text-sm text-muted-foreground">{d}</p>
            </div>
          ))}
        </div>
      </Section>
      <Dialog open={rulesOpen} onOpenChange={setRulesOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Alert rules</DialogTitle><DialogDescription>Set the thresholds used when new platform reviews are synced.</DialogDescription></DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5"><Label htmlFor="negative-threshold">Negative rating at or below</Label><Input id="negative-threshold" type="number" min={1} max={5} value={ruleForm.negative} onChange={(event) => setRuleForm((value) => ({ ...value, negative: Number(event.target.value) }))} /></label>
            <label className="space-y-1.5"><Label htmlFor="unanswered-hours">Unanswered after hours</Label><Input id="unanswered-hours" type="number" min={1} max={720} value={ruleForm.unanswered} onChange={(event) => setRuleForm((value) => ({ ...value, unanswered: Number(event.target.value) }))} /></label>
            <label className="space-y-1.5"><Label htmlFor="rating-drop">Rating drop</Label><Input id="rating-drop" type="number" min={0.1} max={5} step={0.1} value={ruleForm.drop} onChange={(event) => setRuleForm((value) => ({ ...value, drop: Number(event.target.value) }))} /></label>
            <label className="space-y-1.5"><Label htmlFor="volume-spike">Volume spike percent</Label><Input id="volume-spike" type="number" min={10} max={1000} value={ruleForm.spike} onChange={(event) => setRuleForm((value) => ({ ...value, spike: Number(event.target.value) }))} /></label>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setRulesOpen(false)}>Cancel</Button><Button disabled={!rules || updateRules.isPending} onClick={() => {
            if (!rules) return;
            updateRules.mutate({ id: rules.id, patch: { negative_rating_threshold: ruleForm.negative, unanswered_hours: ruleForm.unanswered, rating_drop_threshold: ruleForm.drop, volume_spike_percent: ruleForm.spike } }, { onSuccess: () => { toast.success("Alert rules updated"); setRulesOpen(false); }, onError: (error) => toast.error(error.message) });
          }}>Save rules</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
