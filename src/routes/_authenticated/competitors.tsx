import { createFileRoute } from "@tanstack/react-router";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RTooltip,
  Legend,
} from "recharts";
import { Swords, Info, Loader2 } from "lucide-react";
import { AppShell } from "@/components/app/AppShell";
import {
  PageHeader,
  Section,
  Stars,
  Trend,
  StatCard,
  EmptyState,
} from "@/components/app/primitives";
import { useCompetitors, useLiveReviews } from "@/lib/seovale-db";
import { monthlyTrend } from "@/lib/analytics";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/competitors")({
  head: () => ({
    meta: [
      { title: "Competitor Intelligence — Seovale" },
      {
        name: "description",
        content:
          "Benchmark your reputation score, ratings, review volume and sentiment against tracked competitors in your category.",
      },
      { property: "og:title", content: "Competitor Intelligence — Seovale" },
      { property: "og:description", content: "See where your brand stands in its category." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: CompetitorsPage,
});

function CompetitorsPage() {
  const { data: competitors, isLoading } = useCompetitors();
  const { data: reviews } = useLiveReviews();

  const you = competitors?.find((c) => c.you);
  const sorted = competitors ? [...competitors].sort((a, b) => b.score - a.score) : [];
  const rank = you ? sorted.findIndex((c) => c.you) + 1 : 0;
  const leader = sorted[0];
  const category = competitors?.length
    ? Math.round(competitors.reduce((s, c) => s + c.score, 0) / competitors.length)
    : 0;
  const ourTrend = monthlyTrend(reviews ?? [], 6).map((m) => ({ month: m.month, you: m.score }));

  return (
    <AppShell>
      <PageHeader
        eyebrow="Benchmark"
        title="Competitor Intelligence"
        description="Track how your reputation compares within your category, using tracked competitor data."
      />

      <div className="mb-4 flex items-start gap-3 rounded-xl border border-dashed bg-info-soft/60 p-4 text-sm">
        <Info className="mt-0.5 size-4 shrink-0 text-info" />
        <p className="text-muted-foreground">
          Competitor figures come from the competitors you track. Seovale benchmarks only data you
          or your team have entered, and never claims access to a competitor&apos;s private systems.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : !competitors || competitors.length === 0 ? (
        <EmptyState
          icon={Swords}
          title="No competitors tracked yet"
          description="Add competitors from the database to see benchmarks here."
        />
      ) : (
        <>
          <div className="stagger mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Category rank"
              value={you ? `#${rank} of ${competitors.length}` : "—"}
              sub="By reputation score"
              icon={Swords}
              tone="primary"
            />
            <StatCard
              label="Your score"
              value={you?.score ?? "—"}
              sub={`Category average ${category}`}
              {...(you ? { trend: you.trend } : {})}
              tone="positive"
            />
            <StatCard
              label="Rating gap vs leader"
              value={you && leader ? `${(you.rating - leader.rating).toFixed(1)}★` : "—"}
              sub={leader ? `${leader.name} leads at ${leader.rating}★` : "No data"}
              tone="rating"
            />
            <StatCard
              label="Response advantage"
              value={
                you
                  ? `${you.responseRate - Math.round(competitors.filter((c) => !c.you).reduce((s, c) => s + c.responseRate, 0) / Math.max(1, competitors.filter((c) => !c.you).length))}pts`
                  : "—"
              }
              sub={you ? `Your ${you.responseRate}% vs category` : "No data"}
              tone="positive"
            />
          </div>

          <Section
            className="mb-4"
            title="Your reputation score over time"
            description="Based on your own review history"
          >
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={ourTrend} margin={{ left: -22, right: 8, top: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="month"
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
                    contentStyle={{
                      background: "var(--popover)",
                      border: "1px solid var(--border)",
                      borderRadius: 12,
                      fontSize: 12,
                    }}
                  />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                  <Line
                    type="monotone"
                    dataKey="you"
                    name="Your brand"
                    stroke="var(--chart-1)"
                    strokeWidth={3}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Section>

          <Section
            title="Head-to-head"
            description="Reputation score, rating, volume, sentiment and response rate"
            bodyClassName="p-0"
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-5 py-3 font-semibold">Brand</th>
                    <th className="px-5 py-3 font-semibold">Score</th>
                    <th className="px-5 py-3 font-semibold">Rating</th>
                    <th className="px-5 py-3 font-semibold">Reviews</th>
                    <th className="px-5 py-3 font-semibold">Positive sentiment</th>
                    <th className="px-5 py-3 font-semibold">Response rate</th>
                    <th className="px-5 py-3 font-semibold">Trend</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {sorted.map((c) => (
                    <tr
                      key={c.id}
                      className={cn(
                        "transition-colors hover:bg-accent/40",
                        c.you && "bg-accent/60",
                      )}
                    >
                      <td className="px-5 py-3">
                        <span className="flex items-center gap-2 font-semibold">
                          <span
                            className={cn(
                              "grid size-8 place-items-center rounded-lg font-display text-xs font-bold",
                              c.you
                                ? "bg-gradient-brand text-primary-foreground"
                                : "bg-secondary text-secondary-foreground",
                            )}
                          >
                            {c.name
                              .split(" ")
                              .map((w) => w[0])
                              .join("")
                              .slice(0, 2)}
                          </span>
                          {c.name}
                        </span>
                      </td>
                      <td className="px-5 py-3 font-display font-bold tabular-nums">{c.score}</td>
                      <td className="px-5 py-3">
                        <span className="flex items-center gap-2">
                          <span className="tabular-nums">{c.rating}</span>
                          <Stars value={c.rating} size={11} />
                        </span>
                      </td>
                      <td className="px-5 py-3 tabular-nums">{c.reviews.toLocaleString()}</td>
                      <td className="px-5 py-3">
                        <span className="flex items-center gap-2">
                          <span className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                            <span
                              className="block h-full rounded-full bg-positive"
                              style={{ width: `${c.sentiment}%` }}
                            />
                          </span>
                          <span className="text-xs font-semibold tabular-nums">{c.sentiment}%</span>
                        </span>
                      </td>
                      <td className="px-5 py-3 tabular-nums">{c.responseRate}%</td>
                      <td className="px-5 py-3">
                        <Trend value={c.trend} suffix="" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}
    </AppShell>
  );
}
