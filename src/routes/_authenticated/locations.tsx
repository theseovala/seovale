import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { MapPin, ArrowUpDown, Building2, Users, Loader2 } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RTooltip,
} from "recharts";
import { AppShell } from "@/components/app/AppShell";
import {
  PageHeader,
  Section,
  Stars,
  StatCard,
  Trend,
  StatusBadge,
  EmptyState,
} from "@/components/app/primitives";
import { useLocations, useLiveReviews, useLiveAlerts } from "@/lib/seovale-db";
import { locationStats } from "@/lib/analytics";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/locations")({
  head: () => ({
    meta: [
      { title: "Multi-Location Management — Seovale" },
      {
        name: "description",
        content:
          "Compare branch-level reputation scores, ratings, review volume and response rates across every location from one console.",
      },
      { property: "og:title", content: "Multi-Location Management — Seovale" },
      {
        property: "og:description",
        content: "Centralized reputation control for franchises and multi-location brands.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: LocationsPage,
});

function LocationsPage() {
  const { data: locations, isLoading: loadingLocations } = useLocations();
  const { data: reviews, isLoading: loadingReviews } = useLiveReviews();
  const { data: alerts } = useLiveAlerts();
  const [compare, setCompare] = useState<string[]>([]);

  const isLoading = loadingLocations || loadingReviews;
  const stats = locationStats(reviews ?? []);
  const branches = (locations ?? []).map((l) => {
    const s = stats.find((st) => st.name === l.name);
    const openAlerts = (alerts ?? []).filter((a) => a.location === l.name && !a.resolved).length;
    return {
      ...l,
      score: s?.score ?? 0,
      rating: s?.rating ?? 0,
      reviews: s?.reviews ?? 0,
      responseRate: s?.responseRate ?? 0,
      trend: s?.trend ?? 0,
      openAlerts,
    };
  });

  const toggle = (id: string) =>
    setCompare((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length < 3 ? [...c, id] : c));

  const sortedByScore = [...branches].sort((a, b) => b.score - a.score);
  const best = sortedByScore[0];
  const worst = sortedByScore[sortedByScore.length - 1];
  const totalReviews = branches.reduce((s, b) => s + b.reviews, 0);
  const brandAvg = totalReviews
    ? Math.round((branches.reduce((s, b) => s + b.rating * b.reviews, 0) / totalReviews) * 10) / 10
    : 0;
  const countries = new Set(branches.map((b) => b.country)).size;

  return (
    <AppShell>
      <PageHeader
        eyebrow="Multi-location"
        title="Location Management"
        description="Every branch, ranked and comparable. Roll up to the brand, or drill into a single storefront."
      />

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : branches.length === 0 ? (
        <EmptyState
          icon={MapPin}
          title="No locations yet"
          description="Locations added to the workspace will appear here."
        />
      ) : (
        <>
          <div className="stagger mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Locations"
              value={branches.length}
              sub={`${countries} countries`}
              icon={Building2}
              tone="primary"
            />
            <StatCard
              label="Brand average"
              value={brandAvg || "—"}
              sub="Weighted by review volume"
              icon={MapPin}
              tone="rating"
            />
            <StatCard
              label="Top performer"
              value={best?.city ?? "—"}
              sub={best ? `Score ${best.score} · ${best.rating}★` : ""}
              icon={Users}
              tone="positive"
            />
            <StatCard
              label="Needs attention"
              value={worst?.city ?? "—"}
              sub={worst ? `Score ${worst.score} · trend ${worst.trend}` : ""}
              icon={MapPin}
              tone="negative"
            />
          </div>

          <Section
            className="mb-4"
            title="Branch reputation scores"
            description="Compare all locations at a glance"
          >
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={branches} margin={{ left: -22, right: 8, top: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="city"
                    tickLine={false}
                    axisLine={false}
                    fontSize={12}
                    stroke="var(--muted-foreground)"
                  />
                  <YAxis
                    domain={[0, 100]}
                    tickLine={false}
                    axisLine={false}
                    fontSize={12}
                    stroke="var(--muted-foreground)"
                  />
                  <RTooltip
                    cursor={{ fill: "var(--muted)" }}
                    contentStyle={{
                      background: "var(--popover)",
                      border: "1px solid var(--border)",
                      borderRadius: 12,
                      fontSize: 12,
                    }}
                  />
                  <Bar
                    dataKey="score"
                    name="Reputation score"
                    fill="var(--chart-1)"
                    radius={[6, 6, 0, 0]}
                    animationDuration={900}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Section>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Section
              title="All locations"
              description="Select up to three to compare side by side"
              bodyClassName="p-0"
            >
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
                      <th className="px-5 py-3 font-semibold">Compare</th>
                      <th className="px-5 py-3 font-semibold">Location</th>
                      <th className="px-5 py-3 font-semibold">Score</th>
                      <th className="px-5 py-3 font-semibold">Rating</th>
                      <th className="px-5 py-3 font-semibold">Reviews</th>
                      <th className="px-5 py-3 font-semibold">Response</th>
                      <th className="px-5 py-3 font-semibold">Open alerts</th>
                      <th className="px-5 py-3 font-semibold">Trend</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {branches.map((l) => (
                      <tr
                        key={l.id}
                        className={cn(
                          "transition-colors hover:bg-accent/40",
                          compare.includes(l.id) && "bg-accent/50",
                        )}
                      >
                        <td className="px-5 py-3">
                          <input
                            type="checkbox"
                            checked={compare.includes(l.id)}
                            onChange={() => toggle(l.id)}
                            className="size-4 accent-[var(--primary)]"
                            aria-label={`Compare ${l.name}`}
                          />
                        </td>
                        <td className="px-5 py-3">
                          <p className="font-semibold">{l.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {l.country} · {l.manager ?? "Unassigned"}
                          </p>
                        </td>
                        <td className="px-5 py-3">
                          <span
                            className={cn(
                              "inline-grid size-9 place-items-center rounded-lg font-display text-xs font-bold",
                              l.score >= 85
                                ? "bg-positive-soft text-positive"
                                : l.score >= 75
                                  ? "bg-accent text-primary"
                                  : "bg-negative-soft text-negative",
                            )}
                          >
                            {l.score}
                          </span>
                        </td>
                        <td className="px-5 py-3">
                          <span className="flex items-center gap-2">
                            <span className="font-semibold tabular-nums">{l.rating}</span>
                            <Stars value={l.rating} size={11} />
                          </span>
                        </td>
                        <td className="px-5 py-3 tabular-nums">{l.reviews.toLocaleString()}</td>
                        <td className="px-5 py-3">
                          <StatusBadge
                            status={`${l.responseRate}%`}
                            className={
                              l.responseRate >= 90
                                ? "bg-positive-soft text-positive"
                                : "bg-warning-soft text-rating-foreground"
                            }
                          />
                        </td>
                        <td className="px-5 py-3 tabular-nums">{l.openAlerts}</td>
                        <td className="px-5 py-3">
                          <Trend value={l.trend} suffix="" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>

            <Section
              title="Side-by-side comparison"
              description={
                compare.length ? `${compare.length} selected` : "Select locations to compare"
              }
            >
              {compare.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  Tick locations in the table to compare them here.
                </p>
              ) : (
                <div className="space-y-4">
                  {compare.map((id) => {
                    const l = branches.find((b) => b.id === id);
                    if (!l) return null;
                    return (
                      <div key={id} className="rounded-xl border p-4">
                        <div className="flex items-center justify-between">
                          <p className="font-semibold">{l.name}</p>
                          <Trend value={l.trend} suffix="" />
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                          {[
                            ["Score", l.score],
                            ["Rating", l.rating],
                            ["Reviews", l.reviews.toLocaleString()],
                            ["Response", `${l.responseRate}%`],
                          ].map(([k, v]) => (
                            <div key={k as string} className="rounded-lg bg-muted/60 px-3 py-2">
                              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                                {k}
                              </p>
                              <p className="font-display text-base font-bold">{v}</p>
                            </div>
                          ))}
                        </div>
                        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-gradient-brand transition-all duration-700"
                            style={{ width: `${l.score}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Section>
          </div>
        </>
      )}
    </AppShell>
  );
}
