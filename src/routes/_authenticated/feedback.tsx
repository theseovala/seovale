import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";
import { ThumbsUp, ThumbsDown, Lightbulb, MessageCircleHeart, Sparkles, RefreshCcw } from "lucide-react";
import { AppShell } from "@/components/app/AppShell";
import { PageHeader, Section, StatCard, Trend, SentimentBar, EmptyState } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useApp } from "@/lib/app-context";
import { useLiveReviews } from "@/lib/seovale-db";
import { byLocation, feedbackThemes } from "@/lib/analytics";
import { analyseFeedback } from "@/lib/ai.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/feedback")({
  head: () => ({
    meta: [
      { title: "Customer Feedback — Seovale" },
      {
        name: "description",
        content:
          "Recurring themes, praise, complaints and improvement opportunities extracted from every review and survey response.",
      },
      { property: "og:title", content: "Customer Feedback — Seovale" },
      { property: "og:description", content: "Turn thousands of comments into a short list of things to fix." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: FeedbackPage,
});

function FeedbackPage() {
  const { location } = useApp();
  const { data: allReviews, isLoading } = useLiveReviews();
  const reviews = byLocation(allReviews ?? [], location);
  const themes = feedbackThemes(reviews);
  const positive = themes.filter((t) => t.kind === "positive");
  const negative = themes.filter((t) => t.kind === "negative");

  const analyseFn = useServerFn(analyseFeedback);
  const insightMutation = useMutation({
    mutationFn: () => analyseFn({ data: { location } }),
    onError: (err: Error) => toast.error(err.message || "Could not analyse feedback."),
  });

  useEffect(() => {
    if (!isLoading) insightMutation.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location, isLoading]);

  const totalMentions = themes.reduce((s, t) => s + t.mentions, 0);
  const topPraise = positive[0];
  const topComplaint = [...negative].sort((a, b) => b.mentions - a.mentions)[0];

  return (
    <AppShell>
      <PageHeader
        eyebrow="Improve"
        title="Customer Feedback"
        description="What customers keep telling you — grouped into themes, ranked by volume and sentiment, so you know what to fix first."
      />

      <div className="stagger mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Comments analysed" value={reviews.length.toLocaleString()} sub="Reviews with tagged themes" icon={MessageCircleHeart} tone="primary" />
        <StatCard
          label="Top praise"
          value={topPraise ? topPraise.theme : "—"}
          sub={topPraise ? `${topPraise.mentions} mentions · ${topPraise.sentiment}% positive` : "No data yet"}
          {...(topPraise && topPraise.change !== null ? { trend: topPraise.change } : {})}
          icon={ThumbsUp}
          tone="positive"
        />
        <StatCard
          label="Top complaint"
          value={topComplaint ? topComplaint.theme : "—"}
          sub={topComplaint ? `${topComplaint.mentions} mentions · ${topComplaint.sentiment}% positive` : "No data yet"}
          {...(topComplaint && topComplaint.change !== null ? { trend: topComplaint.change } : {})}
          icon={ThumbsDown}
          tone="negative"
        />
        <StatCard label="Opportunities" value={negative.length} sub="High volume, low sentiment themes" icon={Lightbulb} tone="rating" />
      </div>

      <Section
        className="mb-4"
        title="AI insight"
        description={`Live briefing generated from recent reviews in ${location}`}
        action={
          <Button variant="ghost" size="sm" onClick={() => insightMutation.mutate()} disabled={insightMutation.isPending}>
            <RefreshCcw className={cn("size-3.5", insightMutation.isPending && "animate-spin")} /> Refresh
          </Button>
        }
      >
        {insightMutation.isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : insightMutation.isError ? (
          <p className="text-sm text-negative">{(insightMutation.error as Error).message}</p>
        ) : insightMutation.data ? (
          <div className="flex gap-3">
            <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-primary">
              <Sparkles className="size-4" />
            </span>
            <p className="whitespace-pre-line text-sm text-foreground">{insightMutation.data.insight}</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No insight yet.</p>
        )}
      </Section>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Section title="Recurring themes" description="Every theme, ranked by mention volume" bodyClassName="p-0">
          {isLoading ? (
            <div className="space-y-2 p-5">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : themes.length === 0 ? (
            <div className="p-5">
              <EmptyState icon={MessageCircleHeart} title="No themes yet" description="Tag your reviews to see recurring themes here." />
            </div>
          ) : (
            <ul className="divide-y">
              {themes.map((t) => (
                <li key={t.theme} className="px-5 py-3.5">
                  <div className="flex items-center gap-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{t.theme}</span>
                      <span className="text-xs text-muted-foreground">{t.mentions.toLocaleString()} mentions</span>
                    </span>
                    <span className={cn(
                      "rounded-full px-2.5 py-0.5 text-[11px] font-bold",
                      t.sentiment >= 70 ? "bg-positive-soft text-positive" : t.sentiment >= 45 ? "bg-warning-soft text-rating-foreground" : "bg-negative-soft text-negative",
                    )}>{t.sentiment}% positive</span>
                    {t.change === null ? null : <Trend value={t.change} suffix="pts" />}
                  </div>
                  <SentimentBar className="mt-2 h-1.5" positive={t.sentiment} neutral={Math.round((100 - t.sentiment) * 0.4)} negative={100 - t.sentiment - Math.round((100 - t.sentiment) * 0.4)} />
                </li>
              ))}
            </ul>
          )}
        </Section>

        <div className="flex flex-col gap-4">
          <Section title="What customers love" description="Protect and amplify these strengths">
            {positive.length === 0 ? (
              <p className="text-sm text-muted-foreground">No strongly positive themes yet.</p>
            ) : (
              <ul className="space-y-2.5">
                {positive.map((t) => (
                  <li key={t.theme} className="flex items-center gap-3 rounded-lg bg-positive-soft/70 px-3 py-2.5">
                    <ThumbsUp className="size-4 shrink-0 text-positive" />
                    <span className="flex-1 text-sm font-medium">{t.theme}</span>
                    <span className="text-xs font-semibold tabular-nums text-muted-foreground">{t.mentions}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Improvement opportunities" description="Highest impact fixes, ranked">
            {negative.length === 0 ? (
              <p className="text-sm text-muted-foreground">No significant negative themes right now.</p>
            ) : (
              <ul className="space-y-2.5">
                {negative.map((t, i) => (
                  <li key={t.theme} className="rounded-lg border border-negative/20 bg-negative-soft/60 p-3">
                    <div className="flex items-center gap-2">
                      <span className="grid size-6 place-items-center rounded-md bg-negative text-[11px] font-bold text-destructive-foreground">{i + 1}</span>
                      <span className="flex-1 text-sm font-semibold">{t.theme}</span>
                      {t.change === null ? null : <Trend value={t.change} suffix="pts" />}
                    </div>
                    <p className="mt-1.5 pl-8 text-xs text-muted-foreground">
                      {t.mentions} mentions · sentiment {t.sentiment}%.
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </AppShell>
  );
}
