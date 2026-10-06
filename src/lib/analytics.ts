// Every chart and table figure in Seovale is derived here from stored reviews.
import type { LiveReview } from "@/lib/seovale-db";
import { computeReputation } from "@/lib/reputation";
import type { PlatformId, Sentiment } from "@/lib/domain";

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const round1 = (n: number) => Math.round(n * 10) / 10;

export function withinDays(reviews: LiveReview[], days: number) {
  const cutoff = Date.now() - days * 86_400_000;
  return reviews.filter((r) => new Date(r.external_created_at).getTime() >= cutoff);
}

export function byLocation(reviews: LiveReview[], location: string) {
  if (!location || location === "All locations") return reviews;
  return reviews.filter((r) => r.location === location);
}

export interface MonthPoint {
  month: string;
  rating: number;
  reviews: number;
  score: number;
}

/** Rating, volume and reputation score per calendar month, oldest first. */
export function monthlyTrend(reviews: LiveReview[], months = 12): MonthPoint[] {
  const now = new Date();
  const out: MonthPoint[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const bucket = reviews.filter((r) => {
      const t = new Date(r.external_created_at).getTime();
      return t >= d.getTime() && t < next.getTime();
    });
    const label = MONTH[d.getMonth()]!;
    if (bucket.length === 0) {
      out.push({ month: label, rating: 0, reviews: 0, score: 0 });
      continue;
    }
    out.push({
      month: label,
      rating: round1(bucket.reduce((s, r) => s + r.rating, 0) / bucket.length),
      reviews: bucket.length,
      score: computeReputation(bucket).score,
    });
  }
  return out;
}

export interface SentimentPoint {
  week: string;
  positive: number;
  neutral: number;
  negative: number;
}

/** Sentiment mix per week for the last `weeks` weeks, oldest first. */
export function sentimentTrend(reviews: LiveReview[], weeks = 8): SentimentPoint[] {
  const out: SentimentPoint[] = [];
  const now = Date.now();
  for (let i = weeks - 1; i >= 0; i--) {
    const end = now - i * 7 * 86_400_000;
    const start = end - 7 * 86_400_000;
    const bucket = reviews.filter((r) => {
      const t = new Date(r.external_created_at).getTime();
      return t >= start && t < end;
    });
    const pct = (s: Sentiment) =>
      bucket.length === 0
        ? 0
        : Math.round((bucket.filter((r) => r.sentiment === s).length / bucket.length) * 100);
    out.push({
      week: `W${weeks - i}`,
      positive: pct("positive"),
      neutral: pct("neutral"),
      negative: pct("negative"),
    });
  }
  return out;
}

export interface PlatformStat {
  id: PlatformId;
  rating: number;
  reviews: number;
  response: number;
  share: number;
}

export function platformPerformance(reviews: LiveReview[]): PlatformStat[] {
  const map = new Map<PlatformId, LiveReview[]>();
  for (const r of reviews) {
    const list = map.get(r.platform) ?? [];
    list.push(r);
    map.set(r.platform, list);
  }
  const total = reviews.length || 1;
  return [...map.entries()]
    .map(([id, list]) => ({
      id,
      rating: round1(list.reduce((s, r) => s + r.rating, 0) / list.length),
      reviews: list.length,
      response: Math.round((list.filter((r) => r.reply).length / list.length) * 100),
      share: Math.round((list.length / total) * 100),
    }))
    .sort((a, b) => b.reviews - a.reviews);
}

export interface LocationStat {
  name: string;
  score: number;
  rating: number;
  reviews: number;
  responseRate: number;
  trend: number;
  negative: number;
}

export function locationStats(reviews: LiveReview[]): LocationStat[] {
  const map = new Map<string, LiveReview[]>();
  for (const r of reviews) {
    const list = map.get(r.location) ?? [];
    list.push(r);
    map.set(r.location, list);
  }
  return [...map.entries()]
    .map(([name, list]) => {
      const recent = withinDays(list, 30);
      const prior = list.filter((r) => {
        const t = new Date(r.external_created_at).getTime();
        return t < Date.now() - 30 * 86_400_000 && t >= Date.now() - 90 * 86_400_000;
      });
      const summary = computeReputation(list);
      const recentScore = recent.length ? computeReputation(recent).score : summary.score;
      const priorScore = prior.length ? computeReputation(prior).score : summary.score;
      return {
        name,
        score: summary.score,
        rating: summary.avgRating,
        reviews: list.length,
        responseRate: summary.responseRate,
        trend: round1(recentScore - priorScore),
        negative: summary.sentimentCounts.negative,
      };
    })
    .sort((a, b) => b.score - a.score);
}

export interface Theme {
  theme: string;
  mentions: number;
  sentiment: number;
  change: number | null;
  kind: Sentiment;
}

/** Feedback themes built from the tags attached to stored reviews. */
export function feedbackThemes(reviews: LiveReview[], limit = 10): Theme[] {
  const map = new Map<string, { all: LiveReview[]; recent: LiveReview[]; prior: LiveReview[] }>();
  const now = Date.now();
  for (const r of reviews) {
    for (const tag of r.tags) {
      const entry = map.get(tag) ?? { all: [], recent: [], prior: [] };
      entry.all.push(r);
      const t = new Date(r.external_created_at).getTime();
      if (t >= now - 30 * 86_400_000) entry.recent.push(r);
      else if (t >= now - 60 * 86_400_000) entry.prior.push(r);
      map.set(tag, entry);
    }
  }
  const posPct = (list: LiveReview[]) =>
    list.length ? (list.filter((r) => r.sentiment === "positive").length / list.length) * 100 : 0;

  return [...map.entries()]
    .map(([theme, e]) => {
      const sentiment = Math.round(posPct(e.all));
      // Only report a trend when both comparison windows carry enough mentions
      // to be meaningful; otherwise leave it blank instead of showing a fake 0%.
      const change =
        e.recent.length >= 3 && e.prior.length >= 3
          ? Math.round(posPct(e.recent) - posPct(e.prior))
          : null;
      return {
        theme,
        mentions: e.all.length,
        sentiment,
        change,
        kind: (sentiment >= 65 ? "positive" : sentiment >= 40 ? "neutral" : "negative") as Sentiment,
      };
    })
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, limit);
}

/** Month-by-month reputation score, used to benchmark against competitors. */
export function scoreHistory(reviews: LiveReview[], months = 6) {
  return monthlyTrend(reviews, months).map((m) => ({ month: m.month, you: m.score }));
}

export function responseTimeHours(reviews: LiveReview[]): number | null {
  const answered = reviews.filter((r) => r.replied_at);
  if (answered.length === 0) return null;
  const totals = answered.reduce((sum, r) => {
    const delta =
      new Date(r.replied_at!).getTime() - new Date(r.external_created_at).getTime();
    return sum + Math.max(delta, 0);
  }, 0);
  return round1(totals / answered.length / 3_600_000);
}

export function monthlyResponseTime(reviews: LiveReview[], months = 6) {
  const now = new Date();
  return Array.from({ length: months }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - (months - 1 - index), 1);
    const monthReviews = reviews.filter((review) => {
      const created = new Date(review.external_created_at);
      return created.getFullYear() === date.getFullYear() && created.getMonth() === date.getMonth();
    });
    return {
      month: date.toLocaleDateString("en", { month: "short" }),
      hours: responseTimeHours(monthReviews),
    };
  });
}
