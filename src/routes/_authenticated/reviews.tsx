import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Search, Inbox, ChevronDown, Reply, Sparkles, Send, Copy, Check, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app/AppShell";
import {
  PageHeader,
  Section,
  Stars,
  PlatformIcon,
  StatusBadge,
  EmptyState,
  SentimentDot,
} from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { platforms, type PlatformId, type ReviewStatus } from "@/lib/domain";
import {
  useConnectedPlatforms,
  useLiveReviews,
  usePublishReply,
  useUpdateReview,
  type LiveReview,
} from "@/lib/seovale-db";
import { useApp, ALL_LOCATIONS } from "@/lib/app-context";
import { draftReply } from "@/lib/ai.functions";
import { syncGoogleBusinessReviews } from "@/lib/google-business.functions";
import { syncTrustpilotReviews } from "@/lib/trustpilot.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/reviews")({
  head: () => ({
    meta: [
      { title: "Review Center — Seovale" },
      {
        name: "description",
        content:
          "A unified review inbox for Google, Facebook, Instagram, Trustpilot, Yelp and more, with platform, rating, sentiment and location filters.",
      },
      { property: "og:title", content: "Review Center — Seovale" },
      { property: "og:description", content: "Every review from every platform in one inbox." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ReviewCenter,
});

const statuses: (ReviewStatus | "all")[] = ["all", "pending", "replied", "escalated", "flagged"];
const sentiments = ["all", "positive", "neutral", "negative"] as const;
const ratings = ["all", "5", "4", "3", "2", "1"] as const;
type SortKey = "newest" | "oldest" | "rating-high" | "rating-low";

function ReviewCenter() {
  const [platform, setPlatform] = useState<PlatformId | "all">("all");
  const [status, setStatus] = useState<ReviewStatus | "all">("all");
  const [sentiment, setSentiment] = useState<(typeof sentiments)[number]>("all");
  const [rating, setRating] = useState<(typeof ratings)[number]>("all");
  const [sort, setSort] = useState<SortKey>("newest");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);

  const { location, locationNames } = useApp();
  const [loc, setLoc] = useState(ALL_LOCATIONS);

  const { data: reviews = [], isLoading } = useLiveReviews();
  const { data: connected = [] } = useConnectedPlatforms();
  const connectedIds = new Set(
    connected.filter((c) => c.status === "connected").map((c) => c.platform),
  );

  const draftAi = useServerFn(draftReply);
  const aiMutation = useMutation({
    mutationFn: (id: string) => draftAi({ data: { reviewId: id } }),
    onSuccess: (res) => setDraft(res.reply),
    onError: (e) => toast.error("Could not draft reply", { description: (e as Error).message }),
  });
  const publish = usePublishReply();
  const updateReview = useUpdateReview();

  const effectiveLoc = loc === ALL_LOCATIONS ? location : loc;

  const filteredBase = useMemo(
    () =>
      reviews.filter((r) => {
        if (effectiveLoc !== ALL_LOCATIONS && r.location !== effectiveLoc) return false;
        if (platform !== "all" && r.platform !== platform) return false;
        if (status !== "all" && r.status !== status) return false;
        if (sentiment !== "all" && r.sentiment !== sentiment) return false;
        if (rating !== "all" && r.rating !== Number(rating)) return false;
        if (query && !(`${r.author} ${r.body}`.toLowerCase().includes(query.toLowerCase()))) return false;
        return true;
      }),
    [reviews, platform, status, sentiment, rating, query, effectiveLoc],
  );

  const list = useMemo(() => {
    const arr = [...filteredBase];
    arr.sort((a, b) => {
      switch (sort) {
        case "oldest":
          return new Date(a.external_created_at).getTime() - new Date(b.external_created_at).getTime();
        case "rating-high":
          return b.rating - a.rating;
        case "rating-low":
          return a.rating - b.rating;
        default:
          return new Date(b.external_created_at).getTime() - new Date(a.external_created_at).getTime();
      }
    });
    return arr;
  }, [filteredBase, sort]);

  const countByStatus = (s: ReviewStatus | "all") =>
    s === "all" ? reviews.length : reviews.filter((r) => r.status === s).length;

  const openReview = (r: LiveReview) => {
    const isOpen = openId === r.id;
    setOpenId(isOpen ? null : r.id);
    setDraft(isOpen ? "" : (r.reply ?? ""));
    setCopied(false);
    if (!isOpen && !r.reply) aiMutation.mutate(r.id);
  };

  const copyDraft = async () => {
    if (!draft.trim()) return;
    await navigator.clipboard.writeText(draft.trim());
    setCopied(true);
    toast.success("Reply copied for Google");
    window.setTimeout(() => setCopied(false), 1800);
  };

  const queryClient = useQueryClient();
  const syncGoogleFn = useServerFn(syncGoogleBusinessReviews);
  const syncTrustpilotFn = useServerFn(syncTrustpilotReviews);
  const syncAll = useMutation({
    mutationFn: async () => {
      const results: string[] = [];
      if (connectedIds.has("google")) {
        const r = await syncGoogleFn();
        results.push(`Google: ${r.reviewsFound} reviews (${r.reviewsCreated} new)`);
      }
      if (connectedIds.has("trustpilot")) {
        const r = await syncTrustpilotFn();
        results.push(`Trustpilot: ${r.reviewsFound} reviews (${r.reviewsCreated} new)`);
      }
      return results;
    },
    onSuccess: (results) => {
      queryClient.invalidateQueries({ queryKey: ["reviews"] });
      queryClient.invalidateQueries({ queryKey: ["alerts"] });
      toast.success("Live sync complete", { description: results.join(" · ") || "Nothing to sync" });
    },
    onError: (e) => toast.error("Sync failed", { description: (e as Error).message }),
  });

  return (
    <AppShell>
      <PageHeader
        eyebrow="Unified inbox"
        title="Review Center"
        description="Every review from every connected platform, in one place. Filter, triage and open a review to see full context."
        actions={
          (connectedIds.has("google") || connectedIds.has("trustpilot")) ? (
            <Button onClick={() => syncAll.mutate()} disabled={syncAll.isPending}>
              {syncAll.isPending ? <RefreshCw className="animate-spin" /> : <RefreshCw />}
              Sync live reviews
            </Button>
          ) : undefined
        }
      />

      {/* Filter bar */}
      <div className="card-elevated mb-4 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by customer, keyword or phrase…"
              className="h-10 w-full rounded-lg border bg-background pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring/40"
            />
          </div>
          <select
            value={loc}
            onChange={(e) => setLoc(e.target.value)}
            className="h-10 rounded-lg border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring/40"
          >
            {locationNames.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="h-10 rounded-lg border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring/40"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="rating-high">Rating: high to low</option>
            <option value="rating-low">Rating: low to high</option>
          </select>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            onClick={() => setPlatform("all")}
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
              platform === "all" ? "border-primary bg-accent text-primary" : "hover:bg-muted",
            )}
          >
            All platforms
          </button>
          {(Object.keys(platforms) as PlatformId[]).map((p) => (
            <button
              key={p}
              onClick={() => setPlatform(p)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors",
                platform === p ? "border-primary bg-accent text-primary" : "hover:bg-muted",
                !connectedIds.has(p) && "opacity-50",
              )}
            >
              <PlatformIcon id={p} size="sm" />
              {platforms[p].name}
            </button>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap gap-4 border-t pt-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground">Status:</span>
            <div className="flex flex-wrap gap-1">
              {statuses.map((s) => (
                <button
                  key={s}
                  onClick={() => setStatus(s)}
                  className={cn(
                    "rounded-md px-2 py-1 text-xs font-medium capitalize transition-colors",
                    status === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  {s === "all" ? "All" : s} ({countByStatus(s)})
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground">Sentiment:</span>
            <div className="flex flex-wrap gap-1">
              {sentiments.map((s) => (
                <button
                  key={s}
                  onClick={() => setSentiment(s)}
                  className={cn(
                    "rounded-md px-2 py-1 text-xs font-medium capitalize transition-colors",
                    sentiment === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  {s === "all" ? "All" : s}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground">Rating:</span>
            <div className="flex flex-wrap gap-1">
              {ratings.map((r) => (
                <button
                  key={r}
                  onClick={() => setRating(r)}
                  className={cn(
                    "rounded-md px-2 py-1 text-xs font-medium transition-colors",
                    rating === r ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  {r === "all" ? "All" : `${r}★`}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <Section
        title={isLoading ? "Loading reviews…" : `${list.length} reviews`}
        description="Click a review to expand full detail and response history"
        bodyClassName="p-0"
      >
        {isLoading ? (
          <div className="space-y-3 p-5">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton-shimmer h-16 rounded-xl" />
            ))}
          </div>
        ) : list.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={Inbox}
              title="No reviews match these filters"
              description="Try widening the date range, clearing platform filters or searching a different keyword."
              action={
                <Button
                  variant="outline"
                  onClick={() => {
                    setPlatform("all");
                    setStatus("all");
                    setSentiment("all");
                    setRating("all");
                    setQuery("");
                    setLoc(ALL_LOCATIONS);
                  }}
                >
                  Reset filters
                </Button>
              }
            />
          </div>
        ) : (
          <ul className="divide-y">
            {list.map((r) => {
              const open = openId === r.id;
              return (
                <li key={r.id} className={cn("transition-colors", r.unread && "bg-accent/30")}>
                  <button
                    onClick={() => openReview(r)}
                    className="flex w-full items-start gap-3 px-4 py-4 text-left transition-colors hover:bg-accent/40 md:px-5"
                  >
                    <span className="relative">
                      <span className="grid size-10 place-items-center rounded-full bg-secondary font-display text-xs font-bold text-secondary-foreground">
                        {r.initials}
                      </span>
                      <PlatformIcon id={r.platform} size="sm" className="absolute -bottom-1 -right-1 ring-2 ring-card" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-sm font-bold">{r.author}</span>
                        {r.unread && <span className="size-1.5 rounded-full bg-primary" />}
                        <Stars value={r.rating} size={12} />
                        <SentimentDot s={r.sentiment} />
                        <span className="ml-auto flex items-center gap-2">
                          <StatusBadge status={r.status} />
                          <span className="text-[11px] text-muted-foreground">{r.date}</span>
                          <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")} />
                        </span>
                      </span>
                      {r.title && <span className="mt-1 block text-sm font-semibold">{r.title}</span>}
                      <span className={cn("mt-1 block text-sm text-muted-foreground", !open && "line-clamp-2")}>{r.body}</span>
                      <span className="mt-2 flex flex-wrap items-center gap-1.5">
                        {r.tags.map((t) => (
                          <span key={t} className="rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{t}</span>
                        ))}
                        <span className="text-[11px] text-muted-foreground">· {r.location}</span>
                      </span>
                    </span>
                  </button>

                  {open && (
                    <div className="animate-rise border-t bg-muted/30 px-4 py-4 md:px-5">
                      {r.reply && (
                        <div className="mb-3 rounded-lg border bg-card p-4">
                          <p className="text-xs font-semibold text-positive">Your published response</p>
                          <p className="mt-1 text-sm">{r.reply}</p>
                        </div>
                      )}

                      <div className="rounded-lg border bg-card p-4">
                        <div className="mb-2 flex items-center justify-between">
                          <p className="text-xs font-semibold text-muted-foreground">
                            {r.reply ? "Update response" : aiMutation.isPending ? "Creating reply draft…" : "AI reply draft"}
                          </p>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={aiMutation.isPending}
                            onClick={() => aiMutation.mutate(r.id)}
                          >
                            <Sparkles /> {aiMutation.isPending ? "Drafting…" : "Write with AI"}
                          </Button>
                        </div>
                        <textarea
                          value={openId === r.id ? draft : ""}
                          onChange={(e) => setDraft(e.target.value)}
                          rows={4}
                          placeholder="Draft a reply that acknowledges the feedback and offers a next step…"
                          className="w-full rounded-lg border bg-background p-3 text-sm outline-none focus:ring-2 focus:ring-ring/40"
                        />
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!draft.trim()}
                            onClick={() => void copyDraft()}
                          >
                            {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy for Google"}
                          </Button>
                          <Button
                            size="sm"
                            disabled={!draft.trim() || publish.isPending}
                            onClick={() =>
                              publish.mutate(
                                { id: r.id, reply: draft.trim() },
                                {
                                  onSuccess: () => toast.success("Response published", { description: `Reply saved for ${r.author}.` }),
                                  onError: (e) => toast.error("Could not publish", { description: (e as Error).message }),
                                },
                              )
                            }
                          >
                            <Send /> {publish.isPending ? "Publishing…" : "Publish"}
                          </Button>
                        </div>
                      </div>

                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            updateReview.mutate(
                              { id: r.id, patch: { status: r.status === "escalated" ? "pending" : "escalated" } },
                              { onError: (e) => toast.error("Could not update status", { description: (e as Error).message }) },
                            )
                          }
                        >
                          <Reply /> {r.status === "escalated" ? "Un-escalate" : "Escalate"}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            updateReview.mutate(
                              { id: r.id, patch: { priority: r.priority === "high" ? "medium" : "high" } },
                              { onError: (e) => toast.error("Could not update priority", { description: (e as Error).message }) },
                            )
                          }
                        >
                          {r.priority === "high" ? "Lower priority" : "Mark high priority"}
                        </Button>
                        {r.unread && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              updateReview.mutate(
                                { id: r.id, patch: { unread: false } },
                                { onError: (e) => toast.error("Could not update", { description: (e as Error).message }) },
                              )
                            }
                          >
                            Mark as read
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </AppShell>
  );
}
