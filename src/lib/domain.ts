// Seovale domain types and platform metadata. No sample data lives here —
// every figure in the product is derived from stored reviews.

export const BRAND = {
  name: "Seovale",
  legal: "Seovale",
  tagline: "Online reputation command center",
  footer: "Seovale",
} as const;

export type PlatformId =
  "google" | "facebook" | "instagram" | "youtube" | "trustpilot" | "yelp" | "tripadvisor";

export const platforms: Record<PlatformId, { name: string; short: string; color: string }> = {
  google: { name: "Google Reviews", short: "G", color: "oklch(0.62 0.18 255)" },
  facebook: { name: "Facebook", short: "f", color: "oklch(0.5 0.17 260)" },
  instagram: { name: "Instagram", short: "ig", color: "oklch(0.62 0.22 350)" },
  youtube: { name: "YouTube", short: "yt", color: "oklch(0.58 0.22 28)" },
  trustpilot: { name: "Trustpilot", short: "tp", color: "oklch(0.7 0.16 155)" },
  yelp: { name: "Yelp", short: "y", color: "oklch(0.55 0.22 25)" },
  tripadvisor: { name: "TripAdvisor", short: "ta", color: "oklch(0.68 0.16 150)" },
};

export const platformName = (id: string) =>
  platforms[id as PlatformId]?.name ?? id.charAt(0).toUpperCase() + id.slice(1);

export type Sentiment = "positive" | "neutral" | "negative";
export type ReviewStatus = "pending" | "replied" | "escalated" | "flagged";

export interface Review {
  id: string;
  platform: PlatformId;
  author: string;
  initials: string;
  rating: number;
  sentiment: Sentiment;
  status: ReviewStatus;
  priority: "high" | "medium" | "low";
  location: string;
  date: string;
  title?: string;
  body: string;
  tags: string[];
  unread: boolean;
  reply?: string;
}

export interface Alert {
  id: string;
  type: "negative" | "drop" | "spike" | "unusual" | "unresolved" | "suspicious";
  severity: "critical" | "high" | "medium" | "info";
  title: string;
  detail: string;
  location: string;
  time: string;
  resolved: boolean;
}

export interface Competitor {
  id: string;
  name: string;
  score: number;
  rating: number;
  reviews: number;
  sentiment: number;
  trend: number;
  responseRate: number;
  notes?: string;
  you?: boolean;
}

export interface LocationRecord {
  id: string;
  name: string;
  city: string;
  country: string;
  manager: string | null;
}
