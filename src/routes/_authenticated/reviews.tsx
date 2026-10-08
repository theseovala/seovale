import { useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Search,
  Inbox,
  ChevronDown,
  Reply,
  Sparkles,
  Send,
  Copy,
  Check,
  RefreshCw,
  MapPin,
} from "lucide-react";
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
import { Input } from "@/components/ui/input";
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
import {
  resolveGoogleMapsUrlForWorkspace,
  scanGooglePlaceIdForWorkspace,
  scanGooglePlacesReviews,
} from "@/lib/google-places.functions";
import type { GooglePlaceSnapshot } from "@/lib/google-places.server";
import { syncTrustpilotReviews } from "@/lib/trustpilot.functions";
import { listIntegrations } from "@/lib/integrations.functions";
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

function GooglePlaceReviewCard({ review }: { review: GooglePlaceSnapshot["reviews"][number] }) {
  const [showOriginal, setShowOriginal] = useState(false);
  const isTranslated =
    Boolean(review.originalText) &&
    review.originalText !== review.text &&
    (review.textLanguage && review.originalLanguage
      ? review.textLanguage !== review.originalLanguage
      : true);
  const reviewText = showOriginal && review.originalText ? review.originalText : review.text;

  return (
    <li className="space-y-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {review.authorPhotoUrl && (
          <img
            src={review.authorPhotoUrl}
            alt=""
            aria-hidden="true"
            loading="lazy"
            referrerPolicy="no-referrer"
            className="size-8 rounded-full object-cover"
          />
        )}
        {review.authorUrl ? (
          <a
            href={review.authorUrl}
            target="_blank"
            rel="noreferrer"
            className="font-semibold underline underline-offset-2"
          >
            {review.author}
          </a>
        ) : review.author ? (
          <span className="font-semibold">{review.author}</span>
        ) : (
          <span className="text-sm text-muted-foreground">Reviewer attribution unavailable</span>
        )}
        <Stars value={review.rating} />
        {review.relativePublishedAt ? (
          <span className="text-xs text-muted-foreground">{review.relativePublishedAt}</span>
        ) : (
          review.publishedAt && (
            <time className="text-xs text-muted-foreground" dateTime={review.publishedAt}>
              {new Date(review.publishedAt).toLocaleDateString()}
            </time>
          )
        )}
        {review.visitYear && review.visitMonth && (
          <span className="text-xs text-muted-foreground">
            Visited{" "}
            {new Date(review.visitYear, review.visitMonth - 1).toLocaleString(undefined, {
              month: "long",
              year: "numeric",
            })}
          </span>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {reviewText || "Rating only — no written review."}
      </p>
      {isTranslated && (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="text-muted-foreground">
            Google-provided translation{review.textLanguage ? ` (${review.textLanguage})` : ""}.
          </span>
          <button
            type="button"
            onClick={() => setShowOriginal((current) => !current)}
            className="text-primary underline underline-offset-2"
          >
            {showOriginal ? "Show translation" : "View original"}
            {review.originalLanguage ? ` (${review.originalLanguage})` : ""}
          </button>
        </div>
      )}
      <div className="flex flex-wrap gap-4 text-xs">
        <a
          href={review.reviewUrl}
          target="_blank"
          rel="noreferrer"
          className="text-primary underline underline-offset-2"
        >
          View this review on Google Maps
        </a>
        {review.flagContentUrl && (
          <a
            href={review.flagContentUrl}
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-primary underline underline-offset-2"
          >
            Report this review to Google
          </a>
        )}
      </div>
    </li>
  );
}

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
  // Trustpilot is connected in the Integration Manager, which records it on its
  // own integration row; its connected_platforms row only turns "connected"
  // after a first successful sync. Reading that row alone would never offer the
  // first Trustpilot sync, so Trustpilot's own verified status counts too.
  const listIntegrationsFn = useServerFn(listIntegrations);
  const { data: integrations } = useQuery({
    queryKey: ["integrations"],
    queryFn: () => listIntegrationsFn(),
  });
  const trustpilotReady = (integrations?.items ?? []).some(
    (i) => i.provider === "trustpilot" && i.status === "connected",
  );
  const googlePlacesReady = (integrations?.items ?? []).some(
    (i) =>
      i.provider === "google_maps" &&
      i.configured &&
      typeof i.accountRef === "string" &&
      i.accountRef.length > 0,
  );
  const connectedIds = new Set([
    ...connected.filter((c) => c.status === "connected").map((c) => c.platform),
    ...(trustpilotReady ? ["trustpilot"] : []),
  ]);

  // Which review is open right now, readable from async callbacks, and the AI
  // drafts already produced this session, keyed by review id.
  const openIdRef = useRef<string | null>(null);
  const aiDrafts = useRef(new Map<string, string>());

  const draftAi = useServerFn(draftReply);
  const aiMutation = useMutation({
    mutationFn: (id: string) => draftAi({ data: { reviewId: id } }),
    onSuccess: (res, id) => {
      aiDrafts.current.set(id, res.reply);
      // A late draft only lands in the review it was requested for.
      if (openIdRef.current === id) setDraft(res.reply);
    },
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
        if (query && !`${r.author} ${r.body}`.toLowerCase().includes(query.toLowerCase()))
          return false;
        return true;
      }),
    [reviews, platform, status, sentiment, rating, query, effectiveLoc],
  );

  const list = useMemo(() => {
    const arr = [...filteredBase];
    arr.sort((a, b) => {
      switch (sort) {
        case "oldest":
          return (
            new Date(a.external_created_at).getTime() - new Date(b.external_created_at).getTime()
          );
        case "rating-high":
          return b.rating - a.rating;
        case "rating-low":
          return a.rating - b.rating;
        default:
          return (
            new Date(b.external_created_at).getTime() - new Date(a.external_created_at).getTime()
          );
      }
    });
    return arr;
  }, [filteredBase, sort]);

  const countByStatus = (s: ReviewStatus | "all") =>
    s === "all" ? reviews.length : reviews.filter((r) => r.status === s).length;

  const openReview = (r: LiveReview) => {
    const isOpen = openId === r.id;
    setOpenId(isOpen ? null : r.id);
    openIdRef.current = isOpen ? null : r.id;
    const cached = aiDrafts.current.get(r.id);
    setDraft(isOpen ? "" : (r.reply ?? cached ?? ""));
    setCopied(false);
    // Auto-draft once per review per session; reopening reuses the draft.
    const inFlight = aiMutation.isPending && aiMutation.variables === r.id;
    if (!isOpen && r.platform !== "google" && !r.reply && cached === undefined && !inFlight) {
      aiMutation.mutate(r.id);
    }
  };

  const platformName = (id: string) => platforms[id as PlatformId]?.name ?? id;

  const copyDraft = async (platformId: string) => {
    if (!draft.trim()) return;
    try {
      await navigator.clipboard.writeText(draft.trim());
      setCopied(true);
      toast.success(`Reply copied for ${platformName(platformId)}`);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Could not copy the reply", {
        description: "Clipboard access was blocked. Select the text and copy it manually.",
      });
    }
  };

  const queryClient = useQueryClient();
  const syncGoogleFn = useServerFn(syncGoogleBusinessReviews);
  const scanGooglePlacesFn = useServerFn(scanGooglePlacesReviews);
  const resolveGoogleMapsUrlFn = useServerFn(resolveGoogleMapsUrlForWorkspace);
  const scanGooglePlaceIdFn = useServerFn(scanGooglePlaceIdForWorkspace);
  const syncTrustpilotFn = useServerFn(syncTrustpilotReviews);
  const [googlePlacesSnapshot, setGooglePlacesSnapshot] = useState<GooglePlaceSnapshot | null>(
    null,
  );
  const [googleMapsUrl, setGoogleMapsUrl] = useState("");
  const [googleMapsScanStage, setGoogleMapsScanStage] = useState<"idle" | "resolving" | "fetching">(
    "idle",
  );
  const scanGoogleMapsUrl = useMutation({
    mutationFn: async () => {
      setGooglePlacesSnapshot(null);
      setGoogleMapsScanStage("resolving");
      const place = await resolveGoogleMapsUrlFn({ data: { url: googleMapsUrl } });
      setGoogleMapsScanStage("fetching");
      return scanGooglePlaceIdFn({ data: { placeId: place.placeId } });
    },
    onSuccess: (snapshot) => {
      setGooglePlacesSnapshot(snapshot);
      setGoogleMapsScanStage("idle");
      toast.success("Live Google Maps scan complete", {
        description: `${snapshot.name}: ${snapshot.reviews.length} real review excerpts from Google Places.`,
      });
    },
    onError: (error) => {
      setGooglePlacesSnapshot(null);
      setGoogleMapsScanStage("idle");
      toast.error("Google Maps scan failed", {
        description: error instanceof Error ? error.message : "Google Places scan failed.",
      });
    },
  });
  const syncAll = useMutation({
    mutationFn: async () => {
      // Providers run independently: a Business Profile approval problem never
      // blocks the public Places rating scan or any other review source.
      type SyncResult = {
        reviewsFound: number;
        reviewsCreated: number;
        places?: GooglePlaceSnapshot;
      };
      const jobs: Array<{ label: string; run: () => Promise<SyncResult> }> = [];
      if (connectedIds.has("google")) jobs.push({ label: "Google", run: () => syncGoogleFn() });
      if (googlePlacesReady)
        jobs.push({
          label: "Google Places",
          run: async () => {
            const places = await scanGooglePlacesFn();
            return { reviewsFound: places.reviews.length, reviewsCreated: 0, places };
          },
        });
      if (connectedIds.has("trustpilot"))
        jobs.push({ label: "Trustpilot", run: () => syncTrustpilotFn() });
      const settled = await Promise.allSettled(jobs.map((job) => job.run()));
      return settled.map((outcome, index) =>
        outcome.status === "fulfilled"
          ? {
              ok: true,
              places: outcome.value.places ?? null,
              text: outcome.value.places
                ? `${jobs[index]!.label}: ${
                    outcome.value.places.rating === null
                      ? "no public rating"
                      : `${outcome.value.places.rating}/5`
                  }${
                    outcome.value.places.ratingCount === null
                      ? ""
                      : ` from ${outcome.value.places.ratingCount.toLocaleString()} ratings`
                  }; ${outcome.value.places.reviews.length} review excerpts`
                : `${jobs[index]!.label}: ${outcome.value.reviewsFound} reviews (${outcome.value.reviewsCreated} new)`,
            }
          : {
              ok: false,
              text: `${jobs[index]!.label}: ${outcome.reason instanceof Error ? outcome.reason.message : "sync failed"}`,
            },
      );
    },
    onSuccess: (results) => {
      setGooglePlacesSnapshot(results.find((result) => result.ok && result.places)?.places ?? null);
      queryClient.invalidateQueries({ queryKey: ["reviews"] });
      queryClient.invalidateQueries({ queryKey: ["alerts"] });
      const failed = results.filter((r) => !r.ok);
      const description = results.map((r) => r.text).join(" · ") || "Nothing to sync";
      if (failed.length === 0) toast.success("Live sync complete", { description });
      else if (failed.length === results.length) toast.error("Sync failed", { description });
      else toast.warning("Sync partly complete", { description });
    },
    onMutate: () => setGooglePlacesSnapshot(null),
    onError: (e) => toast.error("Sync failed", { description: (e as Error).message }),
  });

  return (
    <AppShell>
      <PageHeader
        eyebrow="Unified inbox"
        title="Review Center"
        description="Every review from every connected platform, in one place. Filter, triage and open a review to see full context."
        actions={
          connectedIds.has("google") || googlePlacesReady || connectedIds.has("trustpilot") ? (
            <Button onClick={() => syncAll.mutate()} disabled={syncAll.isPending}>
              {syncAll.isPending ? <RefreshCw className="animate-spin" /> : <RefreshCw />}
              Sync live reviews
            </Button>
          ) : undefined
        }
      />

      <Section
        title="Scan a Google Maps listing"
        description="Paste a Google Maps place, search, listing, or share URL. Public place details and reviews are fetched directly from Google; no owner or Business Profile connection is required."
      >
        <form
          className="flex flex-col gap-3 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (!scanGoogleMapsUrl.isPending) scanGoogleMapsUrl.mutate();
          }}
        >
          <Input
            type="url"
            value={googleMapsUrl}
            onChange={(event) => setGoogleMapsUrl(event.target.value)}
            placeholder="Paste Google Maps URL"
            aria-label="Paste Google Maps URL"
            maxLength={2048}
            required
            disabled={scanGoogleMapsUrl.isPending}
          />
          <Button
            type="submit"
            disabled={scanGoogleMapsUrl.isPending || !googleMapsUrl.trim()}
            className="shrink-0"
          >
            {scanGoogleMapsUrl.isPending ? <RefreshCw className="animate-spin" /> : <MapPin />}
            Scan
          </Button>
        </form>
        {googleMapsScanStage !== "idle" && (
          <p className="mt-3 text-sm text-muted-foreground" role="status" aria-live="polite">
            {googleMapsScanStage === "resolving"
              ? "Resolving Google Place…"
              : "Fetching live place data and reviews…"}
          </p>
        )}
      </Section>

      {googlePlacesSnapshot && (
        <Section
          title="Live public Google rating and reviews"
          description={`Fetched ${new Date(googlePlacesSnapshot.scannedAt).toLocaleString()}. Google selects and orders up to 5 public review excerpts; this live result is not stored in your inbox.`}
        >
          <div className="rounded-xl border bg-white p-4 text-slate-900">
            <p
              translate="no"
              className="mb-3 whitespace-nowrap font-sans text-xs font-normal text-[#5e5e5e]"
            >
              Google Maps
            </p>
            <h3 className="mb-3 text-lg font-semibold">{googlePlacesSnapshot.name}</h3>
            <div className="mb-4 flex flex-wrap items-center gap-3">
              {googlePlacesSnapshot.rating === null ? (
                <span className="text-sm text-muted-foreground">No public rating yet</span>
              ) : (
                <>
                  <span className="text-2xl font-bold">
                    {googlePlacesSnapshot.rating.toFixed(1)}
                  </span>
                  <Stars value={googlePlacesSnapshot.rating} size={18} />
                </>
              )}
              <a
                className="ml-auto text-sm font-medium text-primary underline underline-offset-4"
                href={googlePlacesSnapshot.mapsUrl}
                target="_blank"
                rel="noreferrer"
              >
                View on Google Maps
              </a>
            </div>
            <p className="mb-3 text-sm text-muted-foreground">
              {googlePlacesSnapshot.address ?? "Address not provided by Google"} · Place ID:{" "}
              <code className="break-all">{googlePlacesSnapshot.placeId}</code>
            </p>
            <p className="mb-3 text-sm text-muted-foreground">
              {googlePlacesSnapshot.coordinates
                ? `Coordinates: ${googlePlacesSnapshot.coordinates.latitude}, ${googlePlacesSnapshot.coordinates.longitude}`
                : "Google did not provide coordinates."}
            </p>
            <p className="mb-4 text-sm text-muted-foreground">
              {googlePlacesSnapshot.ratingCount === null
                ? "Google did not provide a rating count."
                : `${googlePlacesSnapshot.ratingCount.toLocaleString()} Google ratings`}
            </p>
            <p className="mb-3 text-xs text-muted-foreground">
              Reviews are ordered by relevance as selected by Google; only up to five excerpts are
              shown, not a complete review-history export.
            </p>
            {googlePlacesSnapshot.reviews.length > 0 ? (
              <ul className="divide-y rounded-xl border">
                {googlePlacesSnapshot.reviews.map((review, index) => (
                  <GooglePlaceReviewCard
                    key={`${review.author}-${review.publishedAt ?? index}`}
                    review={review}
                  />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                Google did not return public review excerpts for this place.
              </p>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              Google does not verify individual reviews and removes fake content when identified.{" "}
              <a
                href="https://support.google.com/contributionpolicy/answer/7422880"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                Learn about Google Maps review policies
              </a>
              . Google hosts the reporting form and decides whether content violates its policies.
              Seovale does not delete reviews. Google Places returns public review excerpts selected
              by Google, not a complete review-history export.
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Google Places excerpts are not sent to OpenAI or Claude for analysis; Google Maps
              terms limit LLM-derived Maps content to its Maps Grounding Lite exception. Use
              Google’s official reporting action; Google decides whether a review violates its
              policies.{" "}
              <a
                href="https://cloud.google.com/maps-platform/terms/maps-service-terms#section-10"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                Terms
              </a>
            </p>
          </div>
        </Section>
      )}

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
              <option key={l} value={l}>
                {l}
              </option>
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
                    status === s
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted",
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
                    sentiment === s
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted",
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
                    rating === r
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted",
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
                      <PlatformIcon
                        id={r.platform}
                        size="sm"
                        className="absolute -bottom-1 -right-1 ring-2 ring-card"
                      />
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
                          <ChevronDown
                            className={cn(
                              "size-4 text-muted-foreground transition-transform",
                              open && "rotate-180",
                            )}
                          />
                        </span>
                      </span>
                      {r.title && (
                        <span className="mt-1 block text-sm font-semibold">{r.title}</span>
                      )}
                      <span
                        className={cn(
                          "mt-1 block text-sm text-muted-foreground",
                          !open && "line-clamp-2",
                        )}
                      >
                        {r.body}
                      </span>
                      <span className="mt-2 flex flex-wrap items-center gap-1.5">
                        {r.tags.map((t) => (
                          <span
                            key={t}
                            className="rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                          >
                            {t}
                          </span>
                        ))}
                        <span className="text-[11px] text-muted-foreground">· {r.location}</span>
                      </span>
                    </span>
                  </button>

                  {open && (
                    <div className="animate-rise border-t bg-muted/30 px-4 py-4 md:px-5">
                      {r.reply && (
                        <div className="mb-3 rounded-lg border bg-card p-4">
                          <p className="text-xs font-semibold text-positive">
                            Your published response
                          </p>
                          <p className="mt-1 text-sm">{r.reply}</p>
                        </div>
                      )}

                      <div className="rounded-lg border bg-card p-4">
                        <div className="mb-2 flex items-center justify-between">
                          <p className="text-xs font-semibold text-muted-foreground">
                            {r.reply
                              ? "Update response"
                              : aiMutation.isPending && aiMutation.variables === r.id
                                ? "Creating reply draft…"
                                : "AI reply draft"}
                          </p>
                          {r.platform === "google" ? (
                            <span className="text-xs text-muted-foreground">
                              AI drafting is disabled for Google reviews.
                            </span>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={aiMutation.isPending && aiMutation.variables === r.id}
                              onClick={() => aiMutation.mutate(r.id)}
                            >
                              <Sparkles />{" "}
                              {aiMutation.isPending && aiMutation.variables === r.id
                                ? "Drafting…"
                                : "Write with AI"}
                            </Button>
                          )}
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
                            onClick={() => void copyDraft(r.platform)}
                          >
                            {copied ? <Check /> : <Copy />}{" "}
                            {copied ? "Copied" : `Copy for ${platformName(r.platform)}`}
                          </Button>
                          <Button
                            size="sm"
                            disabled={!draft.trim() || publish.isPending}
                            onClick={() =>
                              publish.mutate(
                                { id: r.id, reply: draft.trim() },
                                {
                                  onSuccess: () =>
                                    toast.success(
                                      `Reply saved — copy it to ${platformName(r.platform)} to publish`,
                                      {
                                        description: "This action saves the reply in Seovale only.",
                                      },
                                    ),
                                  onError: (e) =>
                                    toast.error("Could not publish", {
                                      description: (e as Error).message,
                                    }),
                                },
                              )
                            }
                          >
                            <Send /> {publish.isPending ? "Publishing…" : "Save reply"}
                          </Button>
                        </div>
                      </div>

                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            updateReview.mutate(
                              {
                                id: r.id,
                                patch: {
                                  status: r.status === "escalated" ? "pending" : "escalated",
                                },
                              },
                              {
                                onError: (e) =>
                                  toast.error("Could not update status", {
                                    description: (e as Error).message,
                                  }),
                              },
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
                              {
                                id: r.id,
                                patch: { priority: r.priority === "high" ? "medium" : "high" },
                              },
                              {
                                onError: (e) =>
                                  toast.error("Could not update priority", {
                                    description: (e as Error).message,
                                  }),
                              },
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
                                {
                                  onError: (e) =>
                                    toast.error("Could not update", {
                                      description: (e as Error).message,
                                    }),
                                },
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
