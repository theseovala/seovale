import { createFileRoute } from "@tanstack/react-router";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  RadarChart,
  Radar,
  PolarGrid,
  PolarAngleAxis,
  ResponsiveContainer,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  Legend,
} from "recharts";
import { Gauge, Star, MessagesSquare, Timer } from "lucide-react";
import { AppShell } from "@/components/app/AppShell";
import { PageHeader, Section, StatCard, Stars, PlatformIcon, Trend, EmptyState } from "@/components/app/primitives";
import { Skeleton } from "@/components/ui/skeleton";
import { platforms } from "@/lib/domain";
import { useApp } from "@/lib/app-context";
import { useLiveReviews } from "@/lib/seovale-db";
import {
  byLocation,
  monthlyTrend,
  sentimentTrend,
  platformPerformance,
  locationStats,
  responseTimeHours,
  monthlyResponseTime,
} from "@/lib/analytics";
import { computeReputation } from "@/lib/reputation";

export const Route = createFileRoute("/_authenticated/analytics")({
  head: () => ({
    meta: [
      { title: "Reputation Analytics — Seovale" },
      {
        name: "description",
        content:
          "Rating trends, review volume, sentiment movement, platform and location performance, and response effectiveness.",
      },
      { property: "og:title", content: "Reputation Analytics — Seovale" },
      { property: "og:description", content: "Understand what is moving your reputation, and why." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Analytics,
});

const chartTip = {
  contentStyle: {
    background: "var(--popover)",
    border: "1px solid var(--border)",
    borderRadius: "12px",
    fontSize: "12px",
    boxShadow: "var(--shadow-card)",
  },
};

function formatHours(hours: number | null) {
  if (hours === null) return "—";
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}h ${m}m`;
}

function Analytics() {
  const { location } = useApp();
  const { data: allReviews, isLoading } = useLiveReviews();
  const reviews = byLocation(allReviews ?? [], location);

  const trend = monthlyTrend(reviews, 6);
  const sentiment = sentimentTrend(reviews, 8);
  const platformStats = platformPerformance(reviews);
  const locStats = locationStats(allReviews ?? []);
  const summary = computeReputation(reviews);
  const avgResponseHours = responseTimeHours(reviews);
  const responseTrend = monthlyResponseTime(reviews, 6);

  const prev = trend.length >= 2 ? trend[trend.length - 2] : undefined;
  const last = trend.length >= 1 ? trend[trend.length - 1] : undefined;
  const scoreTrend = prev && last && prev.score > 0 ? last.score - prev.score : 0;
  const ratingTrend = prev && last && prev.rating > 0 ? Math.round((last.rating - prev.rating) * 10) / 10 : 0;
  const monthlyVelocity = last ? last.reviews : 0;

  const radar = locStats.map((l) => ({ location: l.name, score: l.score }));

  return (
    <AppShell>
      <PageHeader
        eyebrow="Understand"
        title="Reputation Analytics"
        description="Where your reputation is heading, which platforms and locations drive it, and how response performance affects the outcome."
      />

      <div className="stagger mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Reputation score" value={summary.score} sub="Composite of rating, volume, sentiment & response" trend={scoreTrend} icon={Gauge} tone="primary" />
        <StatCard label="Average rating" value={summary.avgRating || "—"} sub={`${summary.total} reviews tracked`} trend={ratingTrend} icon={Star} tone="rating" />
        <StatCard label="Review velocity" value={`${monthlyVelocity}/mo`} sub="Reviews collected this month" icon={MessagesSquare} tone="positive" />
        <StatCard label="Avg response time" value={formatHours(avgResponseHours)} sub="Faster is better" icon={Timer} tone="default" />
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Section className="lg:col-span-2" title="Reputation score & rating trend" description="Composite score vs average rating">
          {isLoading ? (
            <Skeleton className="h-72 w-full" />
          ) : (
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trend} margin={{ left: -18, right: 8, top: 8 }}>
                  <defs>
                    <linearGradient id="aScore" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="month" tickLine={false} axisLine={false} fontSize={12} stroke="var(--muted-foreground)" />
                  <YAxis tickLine={false} axisLine={false} fontSize={12} stroke="var(--muted-foreground)" domain={[0, 100]} />
                  <RTooltip {...chartTip} />
                  <Area type="monotone" dataKey="score" name="Reputation score" stroke="var(--chart-1)" strokeWidth={2.5} fill="url(#aScore)" animationDuration={900} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Section>

        <Section title="Review volume" description="Monthly reviews collected">
          {isLoading ? (
            <Skeleton className="h-72 w-full" />
          ) : (
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={responseTrend} margin={{ left: -22, right: 8, top: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="month" tickLine={false} axisLine={false} fontSize={12} stroke="var(--muted-foreground)" />
                  <YAxis tickLine={false} axisLine={false} fontSize={12} stroke="var(--muted-foreground)" />
                  <RTooltip {...chartTip} cursor={{ fill: "var(--muted)" }} />
                  <Bar dataKey="reviews" name="Reviews" fill="var(--chart-2)" radius={[6, 6, 0, 0]} animationDuration={900} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Section>
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Section title="Sentiment trend" description="Share of positive, neutral and negative reviews per week">
          {isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={sentiment} stackOffset="expand" margin={{ left: -22, right: 8, top: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="week" tickLine={false} axisLine={false} fontSize={12} stroke="var(--muted-foreground)" />
                  <YAxis hide />
                  <RTooltip {...chartTip} />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                  <Area type="monotone" dataKey="positive" stackId="1" stroke="var(--positive)" fill="var(--positive)" fillOpacity={0.75} />
                  <Area type="monotone" dataKey="neutral" stackId="1" stroke="var(--neutral)" fill="var(--neutral)" fillOpacity={0.6} />
                  <Area type="monotone" dataKey="negative" stackId="1" stroke="var(--negative)" fill="var(--negative)" fillOpacity={0.7} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Section>

        <Section title="Response performance" description="Median reply time by month">
          {isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={trend} margin={{ left: -22, right: 8, top: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="month" tickLine={false} axisLine={false} fontSize={12} stroke="var(--muted-foreground)" />
                  <YAxis tickLine={false} axisLine={false} fontSize={12} stroke="var(--muted-foreground)" />
                  <RTooltip {...chartTip} cursor={{ fill: "var(--muted)" }} formatter={(value) => [`${value} hours`, "Median response"]} />
                  <Bar dataKey="hours" name="Median response hours" fill="var(--chart-3)" radius={[6, 6, 0, 0]} animationDuration={900} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Section>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Section className="lg:col-span-2" title="Platform performance" description="Rating, volume, response rate and share of voice" bodyClassName="p-0">
          {platformStats.length === 0 ? (
            <div className="p-5">
              <EmptyState icon={MessagesSquare} title="No platform data yet" description="Connect a platform to see performance here." />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] text-sm">
                <thead>
                  <tr className="border-b bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-5 py-3 font-semibold">Platform</th>
                    <th className="px-5 py-3 font-semibold">Rating</th>
                    <th className="px-5 py-3 font-semibold">Reviews</th>
                    <th className="px-5 py-3 font-semibold">Response rate</th>
                    <th className="px-5 py-3 font-semibold">Share</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {platformStats.map((p) => (
                    <tr key={p.id} className="transition-colors hover:bg-accent/40">
                      <td className="px-5 py-3">
                        <span className="flex items-center gap-2 font-semibold">
                          <PlatformIcon id={p.id} size="sm" /> {platforms[p.id].name}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        <span className="flex items-center gap-2"><span className="font-semibold tabular-nums">{p.rating}</span><Stars value={p.rating} size={11} /></span>
                      </td>
                      <td className="px-5 py-3 tabular-nums">{p.reviews.toLocaleString()}</td>
                      <td className="px-5 py-3">
                        <span className="flex items-center gap-2">
                          <span className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                            <span className="block h-full rounded-full bg-primary" style={{ width: `${p.response}%` }} />
                          </span>
                          <span className="text-xs font-semibold tabular-nums">{p.response}%</span>
                        </span>
                      </td>
                      <td className="px-5 py-3 tabular-nums">{p.share}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <Section title="Location performance" description="Reputation score by branch">
          {locStats.length === 0 ? (
            <EmptyState icon={MessagesSquare} title="No locations yet" description="Location performance will appear once you have data." />
          ) : (
            <>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <RadarChart data={radar} outerRadius="72%">
                    <PolarGrid stroke="var(--border)" />
                    <PolarAngleAxis dataKey="location" fontSize={11} stroke="var(--muted-foreground)" />
                    <Radar dataKey="score" stroke="var(--chart-1)" fill="var(--chart-1)" fillOpacity={0.35} animationDuration={900} />
                    <RTooltip {...chartTip} />
                  </RadarChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-3 space-y-2 border-t pt-3">
                {locStats.slice(0, 4).map((l) => (
                  <div key={l.name} className="flex items-center justify-between text-xs">
                    <span className="font-medium">{l.name}</span>
                    <Trend value={l.trend} suffix="" />
                  </div>
                ))}
              </div>
            </>
          )}
        </Section>
      </div>
    </AppShell>
  );
}
