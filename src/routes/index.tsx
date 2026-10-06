import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  BarChart3,
  Bell,
  Building2,
  MessageSquareQuote,
  Sparkles,
  Star,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/app/primitives";
import { BRAND } from "@/lib/domain";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: `${BRAND.name} — Online Reputation Command Center` },
      {
        name: "description",
        content:
          "Seovale brings every review, rating, alert and report for all your locations into one live command center, with AI replies written in your brand voice.",
      },
      { property: "og:title", content: `${BRAND.name} — Online Reputation Command Center` },
      {
        property: "og:description",
        content:
          "Monitor reviews across every platform, answer customers with AI, and track a single reputation score per location.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Landing,
});

const features = [
  {
    icon: MessageSquareQuote,
    title: "Every review in one inbox",
    body: "Reviews from each connected platform land in a single queue with sentiment, priority and location already sorted.",
  },
  {
    icon: Sparkles,
    title: "Replies written with AI",
    body: "Draft an on-brand answer in seconds, edit it, and publish. The tone and sign-off come from your brand settings.",
  },
  {
    icon: BarChart3,
    title: "One reputation score",
    body: "Rating, volume, sentiment, response rate and recency roll into a score you can track per month and per location.",
  },
  {
    icon: Bell,
    title: "Alerts that matter",
    body: "Rating drops, angry reviews left unanswered and unusual review spikes are flagged the moment they happen.",
  },
  {
    icon: Building2,
    title: "Built for many locations",
    body: "Compare branches side by side and see exactly which one is pulling the brand average down.",
  },
  {
    icon: Star,
    title: "Reports you can send",
    body: "Generate a written monthly report from your real review data and share it with the leadership team.",
  },
];

function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-2">
          <BrandMark />
          <span className="font-display text-lg font-bold tracking-tight">{BRAND.name}</span>
        </div>
        <Button asChild variant="ghost">
          <Link to="/auth">Sign in</Link>
        </Button>
      </header>

      <main>
        <section className="mx-auto max-w-4xl px-6 pb-16 pt-12 text-center sm:pt-20">
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5" /> AI replies, live review data, one score
          </span>
          <h1 className="mt-6 font-display text-4xl font-bold tracking-tight sm:text-6xl">
            Your {BRAND.tagline.toLowerCase()}
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-balance text-base text-muted-foreground sm:text-lg">
            {BRAND.name} watches what customers say about every one of your locations, tells you
            what is going wrong while it is still fixable, and helps you answer in minutes.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg">
              <Link to="/auth">
                Open the command center <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/auth" search={{}}>
                Create an account
              </Link>
            </Button>
          </div>
        </section>

        <section className="border-y border-border bg-muted/30 py-16">
          <div className="mx-auto grid max-w-6xl gap-6 px-6 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((f) => (
              <div
                key={f.title}
                className="rounded-xl border border-border bg-card p-6 shadow-sm transition-shadow hover:shadow-md"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <f.icon className="h-5 w-5" />
                </div>
                <h2 className="mt-4 text-base font-semibold">{f.title}</h2>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-3xl px-6 py-20 text-center">
          <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
            Ready when you are
          </h2>
          <p className="mt-3 text-muted-foreground">
            Sign in to see your locations, reviews and reputation score, and connect your review
            platforms.
          </p>
          <Button asChild size="lg" className="mt-6">
            <Link to="/auth">
              Sign in to {BRAND.name} <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </section>
      </main>

      <footer className="border-t border-border py-8 text-center text-sm text-muted-foreground">
        {BRAND.footer} — {BRAND.tagline}
      </footer>
    </div>
  );
}
