import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Star,
  MessagesSquare,
  Timer,
  ShieldAlert,
  ArrowRight,
  Sparkles,
  ChevronRight,
} from "lucide-react";
import {
  AreaChart,
  Area,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip as RTooltip,
  CartesianGrid,
  BarChart,
  Bar,
} from "recharts";
import { AppShell } from "@/components/app/AppShell";
import { IntegrationStatusStrip } from "@/components/app/IntegrationStatusStrip";
import { IntegrationHealthCard } from "@/components/app/IntegrationHealthCard";
import {
  PageHeader,
  StatCard,
  ScoreRing,
  Section,
  Stars,
  SentimentBar,
  PlatformIcon,
  StatusBadge,
  Trend,
  SentimentDot,
  EmptyState,
} from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { platforms } from "@/lib/domain";
import { useApp } from "@/lib/app-context";
import { useLiveReviews, useLiveAlerts, useConnectedPlatforms } from "@/lib/seovale-db";
import { byLocation, monthlyTrend, platformPerformance, locationStats } from "@/lib/analytics";
import { computeReputation } from "@/lib/reputation";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "Reputation Dashboard — Seovale" },
      {
        name: "description",
        content:
          "Executive reputation overview: score, ratings, sentiment, alerts and platform performance in one command center.",
      },
      { property: "og:title", content: "Reputation Dashboard — Seovale" },
      {
        property: "og:description",
        content: "See how your reputation is today, what needs attention, and what to do next.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dashboard,
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

function Dashboard() {
  const { location } = useApp();
  const { data: allReviews, isLoading: reviewsLoading } = useLiveReviews();
  const { data: alerts, isLoading: alertsLoading } = useLiveAlerts();
  const { data: connectedPlatforms } = useConnectedPlatforms();

  const reviews = byLocation(allReviews ?? [], location);
  const summary = computeReputation(reviews);
  const openAlerts = (alerts ?? []).filter((a) => !a.resolved);
  const pending = reviews.filter((r) => r.status === "pending");
  const trend = monthlyTrend(reviews, 7);
  const platformStats = platformPerformance(reviews);
  const locStats = locationStats(allReviews ?? []);
  const recent = [...reviews]
    .sort((a, b) => new Date(b.external_created_at).getTime() - new Date(a.external_created_at).getTime())
    .slice(0, 4);
  const connectedCount = (connectedPlatforms ?? []).filter((p) => p.status === "connected").length;

  const prevMonth = trend.length >= 2 ? trend[trend.length - 2] : undefined;
  const lastMonth = trend.length >= 1 ? trend[trend.length - 1] : undefined;
  const scoreTrend =
    prevMonth && lastMonth && prevMonth.score > 0 ? lastMonth.score - prevMonth.score : 0;
  const ratingTrendVal =
    prevMonth && lastMonth && prevMonth.rating > 0
      ? Math.round((lastMonth.rating - prevMonth.rating) * 10) / 10
      : 0;

  const isLoading = reviewsLoading || alertsLoading;

  return (
    <AppShell>
      <PageHeader
        eyebrow={`${location}`}
        title="How is your reputation today?"
        description="Your live reputation overview, computed from every stored review."
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/reports">View reports</Link>
            </Button>
            {summary.total > 0 ? (
              <Button asChild>
                <Link to="/responses">
                  Respond to {pending.length} pending <ArrowRight />
                </Link>
              </Button>
            ) : (
              <Button asChild>
                <Link to="/settings">
                  Connect live reviews <ArrowRight />
                </Link>
              </Button>
            )}
          </>
        }
      />

      {isLoading ? (
        <div className="mb-6 grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <div className="mb-6 grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <div className="card-elevated bg-gradient-hero p-6 text-primary-foreground md:p-8">
            {summary.total === 0 ? (
              <div className="flex min-h-48 flex-col justify-center">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary-foreground/70">Verified data only</p>
                <h2 className="mt-2 font-display text-2xl font-bold md:text-3xl">Real data unavailable</h2>
                <p className="mt-2 max-w-lg text-sm text-primary-foreground/80">
                  Connect and sync a review platform to calculate your real reputation score, alerts and trends.
                </p>
              </div>
            ) : (
            <div className="flex flex-col items-center gap-7 md:flex-row md:items-center">
              <div className="rounded-full bg-white/5 p-2 backdrop-blur">
                <ScoreRing score={summary.score} />
              </div>
              <div className="min-w-0 flex-1 text-center md:text-left">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary-foreground/70">
                  Reputation health · {summary.band}
                </p>
                <h2 className="mt-1 font-display text-2xl font-bold md:text-3xl">{summary.headline}</h2>
                <p className="mt-2 max-w-lg text-sm text-primary-foreground/80">
                  {summary.total.toLocaleString()} reviews tracked with an average rating of{" "}
                  {summary.avgRating}★ and a {summary.responseRate}% response rate.
                </p>
                <div className="mt-4 flex flex-wrap justify-center gap-2 md:justify-start">
                  <span className="rounded-full bg-white/12 px-3 py-1 text-xs font-semibold backdrop-blur">
                    {summary.total.toLocaleString()} reviews tracked
                  </span>
                  <span className="rounded-full bg-white/12 px-3 py-1 text-xs font-semibold backdrop-blur">
                    {connectedCount} platforms connected
                  </span>
                  <span className="rounded-full bg-white/12 px-3 py-1 text-xs font-semibold backdrop-blur">
                    {locStats.length} locations
                  </span>
                </div>
              </div>
            </div>
            )}
          </div>

          <Section
            title="What needs your attention"
            description="Highest-impact items right now"
            action={
              <Button variant="ghost" size="sm" asChild>
                <Link to="/alerts">
                  All alerts <ChevronRight />
                </Link>
              </Button>
            }
            bodyClassName="p-0"
          >
            {summary.total === 0 ? (
              <div className="p-5">
                <EmptyState icon={ShieldAlert} title="No verified review data" description="Alerts begin after real reviews are synced." />
              </div>
            ) : openAlerts.length === 0 ? (
              <div className="p-5">
                <EmptyState icon={ShieldAlert} title="No open alerts" description="Everything looks under control right now." />
              </div>
            ) : (
              <ul className="divide-y">
                {openAlerts.slice(0, 4).map((a) => (
                  <li key={a.id}>
                    <Link to="/alerts" className="flex items-start gap-3 px-5 py-3.5 transition-colors hover:bg-accent/50">
                      <span className="mt-1 grid size-8 shrink-0 place-items-center rounded-lg bg-negative-soft text-negative">
                        <ShieldAlert className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-semibold">{a.title}</span>
                          <StatusBadge status={a.severity} />
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {a.location} · {a.time}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}

      <IntegrationStatusStrip />
      <IntegrationHealthCard />

      {/* KPI row */}
      <div className="stagger mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Average rating" value={summary.avgRating || "—"} sub="Across all platforms" trend={ratingTrendVal} icon={Star} tone="rating">
          <Stars value={summary.avgRating} className="mt-3" />
        </StatCard>
        <StatCard label="Total reviews" value={summary.total.toLocaleString()} sub={summary.total ? `${summary.sentiment.positive}% positive` : "No verified reviews"} icon={MessagesSquare} tone="primary" />
        <StatCard label="Response rate" value={summary.total ? `${summary.responseRate}%` : "—"} sub={summary.total ? `${summary.unanswered} unanswered` : "No verified reviews"} icon={Timer} tone="positive" />
        <StatCard label="Open alerts" value={summary.total ? openAlerts.length : "—"} sub={summary.total ? `${connectedCount} platforms connected` : "No verified reviews"} icon={ShieldAlert} tone="negative" />
      </div>

      {/* Charts */}
      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <Section
          className="lg:col-span-2"
          title="Rating & review volume trend"
          description="7-month movement across all connected platforms"
        >
          {isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : trend.every((m) => m.reviews === 0) ? (
            <EmptyState icon={MessagesSquare} title="No review history yet" description="Once reviews come in, the trend will appear here." />
          ) : (
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trend} margin={{ left: -18, right: 8, top: 8 }}>
                  <defs>
                    <linearGradient id="gRating" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.45} />
                      <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="month" tickLine={false} axisLine={false} fontSize={12} stroke="var(--muted-foreground)" />
                  <YAxis domain={[0, 5]} tickLine={false} axisLine={false} fontSize={12} stroke="var(--muted-foreground)" />
                  <RTooltip {...chartTip} />
                  <Area type="monotone" dataKey="rating" stroke="var(--chart-2)" strokeWidth={2.5} fill="url(#gRating)" animationDuration={900} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Section>

        <Section title="Sentiment overview" description="All tracked reviews">
          {summary.total === 0 ? (
            <EmptyState icon={MessagesSquare} title="No sentiment data" description="Sentiment appears after verified reviews are synced." />
          ) : (
          <>
          <div className="flex items-baseline gap-2">
            <span className="font-display text-3xl font-bold">{summary.sentiment.positive}%</span>
            <span className="text-sm text-muted-foreground">positive</span>
          </div>
          <SentimentBar
            positive={summary.sentiment.positive}
            neutral={summary.sentiment.neutral}
            negative={summary.sentiment.negative}
            className="mt-4 h-3"
          />
          <div className="mt-4 grid grid-cols-3 gap-2 text-center">
            {(["positive", "neutral", "negative"] as const).map((s) => (
              <div key={s} className="rounded-lg bg-muted/60 px-2 py-3">
                <SentimentDot s={s} />
                <p className="mt-1 font-display text-base font-bold">{summary.sentiment[s]}%</p>
                <p className="text-[11px] text-muted-foreground">{summary.sentimentCounts[s]} reviews</p>
              </div>
            ))}
          </div>
          <div className="mt-5 h-28">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={summary.distribution} layout="vertical" margin={{ left: -22 }}>
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="stars" tickLine={false} axisLine={false} fontSize={11} stroke="var(--muted-foreground)" tickFormatter={(v) => `${v}★`} />
                <RTooltip {...chartTip} cursor={{ fill: "var(--muted)" }} />
                <Bar dataKey="count" fill="var(--chart-3)" radius={[0, 6, 6, 0]} animationDuration={900} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          </>
          )}
        </Section>
      </div>

      {/* Platform + recent + locations */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Section title="Platform performance" bodyClassName="p-0">
          {platformStats.length === 0 ? (
            <div className="p-5">
              <EmptyState icon={MessagesSquare} title="No platform data" description="Connect a platform to see performance here." />
            </div>
          ) : (
            <ul className="divide-y">
              {platformStats.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-5 py-3">
                  <PlatformIcon id={p.id} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{platforms[p.id].name}</p>
                    <p className="text-xs text-muted-foreground">{p.reviews.toLocaleString()} reviews · {p.response}% answered</p>
                  </div>
                  <div className="text-right">
                    <p className="font-display text-sm font-bold">{p.rating}</p>
                    <Stars value={p.rating} size={10} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          title="Recent reviews"
          action={<Button variant="ghost" size="sm" asChild><Link to="/reviews">Open inbox <ChevronRight /></Link></Button>}
          bodyClassName="p-0"
        >
          {recent.length === 0 ? (
            <div className="p-5">
              <EmptyState icon={MessagesSquare} title="No reviews yet" description="New reviews will show up here as they arrive." />
            </div>
          ) : (
            <ul className="divide-y">
              {recent.map((r) => (
                <li key={r.id}>
                  <Link to="/reviews" className="flex gap-3 px-5 py-3.5 transition-colors hover:bg-accent/50">
                    <PlatformIcon id={r.platform} size="sm" className="mt-0.5" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold">{r.author}</span>
                        <Stars value={r.rating} size={11} />
                      </span>
                      <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{r.body}</span>
                      <span className="mt-1.5 flex items-center gap-2">
                        <StatusBadge status={r.status} />
                        <span className="text-[11px] text-muted-foreground">{r.date}</span>
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <div className="flex flex-col gap-4">
          <Section title="Location snapshot" bodyClassName="p-0">
            {locStats.length === 0 ? (
              <div className="p-5">
                <EmptyState icon={MessagesSquare} title="No locations yet" description="Add locations to see their score here." />
              </div>
            ) : (
              <ul className="divide-y">
                {locStats.slice(0, 4).map((l) => (
                  <li key={l.name} className="flex items-center gap-3 px-5 py-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent font-display text-xs font-bold text-primary">
                      {l.score}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{l.name}</p>
                      <p className="text-xs text-muted-foreground">{l.reviews.toLocaleString()} reviews</p>
                    </div>
                    <Trend value={l.trend} />
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>

      <div className="mt-6 card-elevated flex flex-col items-start gap-4 p-6 md:flex-row md:items-center">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-accent text-primary">
          <Sparkles className="size-5" />
        </span>
        <div className="flex-1">
          <h3 className="font-display text-base font-bold">{summary.total ? "What should you do next?" : "Connect your first live source"}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {summary.total
              ? "Follow the Seovale journey: Dashboard → Alert → Review → Analysis → Action → Report. Start with your open alerts, then clear the response queue."
              : "Real reviews, alerts, analysis and reports will appear only after a verified platform sync completes."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {summary.total ? (
            <>
              <Button variant="outline" asChild><Link to="/analytics">Analyse trend</Link></Button>
              <Button asChild><Link to="/alerts">Start with alerts <ArrowRight /></Link></Button>
            </>
          ) : (
            <Button asChild><Link to="/settings">Connect platform <ArrowRight /></Link></Button>
          )}
        </div>
      </div>
    </AppShell>
  );
}
