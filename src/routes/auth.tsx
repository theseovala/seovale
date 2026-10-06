import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Loader2, ShieldCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BrandMark } from "@/components/app/primitives";
import { BRAND } from "@/lib/domain";

export const Route = createFileRoute("/auth")({
  // Client-only: a server-rendered form accepts typing/clicks before React
  // hydrates, which silently discards the credentials on hydration.
  ssr: false,
  head: () => ({
    meta: [
      { title: `Sign in — ${BRAND.name}` },
      {
        name: "description",
        content: `Sign in to ${BRAND.name} to monitor reviews, answer customers and track your reputation score across every location.`,
      },
      { property: "og:title", content: `Sign in — ${BRAND.name}` },
      {
        property: "og:description",
        content: "Access your reputation command center.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [busy, setBusy] = useState(false);
  // Until React has hydrated, a click would submit the form natively (page
  // reload, no sign-in request). Keep the button disabled until then.
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function sendReset() {
    if (!email) {
      setError("Enter your work email first.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setBusy(false);
    if (resetError) setError(resetError.message);
    else setNotice("Check your inbox for a secure password reset link.");
  }

  useEffect(() => {
    setReady(true);
  }, []);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) void navigate({ to: "/dashboard", replace: true });
    });
  }, [navigate]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "signup") {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/dashboard`,
            data: { full_name: fullName },
          },
        });
        if (signUpError) throw signUpError;
        if (data.session) {
          void navigate({ to: "/dashboard", replace: true });
          return;
        }
        setNotice("Check your inbox — we sent you a link to confirm your address.");
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) throw signInError;
        void navigate({ to: "/dashboard", replace: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="hidden flex-col justify-between bg-gradient-hero p-10 text-primary-foreground lg:flex">
        <Link to="/" className="flex items-center gap-3">
          <BrandMark light />
          <span className="font-display text-lg font-extrabold">{BRAND.name}</span>
        </Link>
        <div className="max-w-md">
          <h1 className="font-display text-4xl font-bold leading-tight">
            Every review, every location, one command center.
          </h1>
          <p className="mt-4 text-sm text-primary-foreground/80">
            {BRAND.name} brings your reviews together, scores your reputation from real data, and
            drafts replies you can send in seconds.
          </p>
          <ul className="mt-8 space-y-3 text-sm text-primary-foreground/85">
            {[
              "A reputation score calculated from your own reviews",
              "AI-written replies that match your tone",
              "Alerts the moment a rating slips",
            ].map((t) => (
              <li key={t} className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 size-4 shrink-0" /> {t}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-primary-foreground/60">{BRAND.name} — {BRAND.tagline}</p>
      </div>

      <div className="flex items-center justify-center px-5 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <BrandMark />
            <span className="font-display text-lg font-extrabold">{BRAND.name}</span>
          </div>
          <h2 className="font-display text-2xl font-bold">
            {mode === "signin" ? "Sign in to your workspace" : "Create your workspace account"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === "signin"
              ? "Use the email address your team invited."
              : "Use your work email address."}
          </p>

          <form onSubmit={submit} className="mt-6 space-y-4">
            {mode === "signup" && (
              <div className="space-y-1.5">
                <Label htmlFor="fullName">Full name</Label>
                <Input
                  id="fullName"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Alex Morgan"
                  required
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="email">Work email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                minLength={8}
                required
              />
            </div>

            {error && (
              <p className="rounded-lg bg-negative-soft px-3 py-2 text-sm text-negative">{error}</p>
            )}
            {notice && (
              <p className="rounded-lg bg-accent px-3 py-2 text-sm text-foreground">{notice}</p>
            )}

            <Button type="submit" className="w-full" disabled={busy || !ready}>
              {(busy || !ready) && <Loader2 className="animate-spin" />}
              {!ready ? "Loading…" : mode === "signin" ? "Sign in" : "Create account"}
            </Button>
            {mode === "signin" && (
              <Button type="button" variant="link" className="h-auto w-full" disabled={busy} onClick={() => void sendReset()}>
                Forgot password?
              </Button>
            )}
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {mode === "signin" ? "No account yet?" : "Already have an account?"}{" "}
            <button
              type="button"
              className="font-semibold text-primary hover:underline"
              onClick={() => {
                setMode(mode === "signin" ? "signup" : "signin");
                setError(null);
                setNotice(null);
              }}
            >
              {mode === "signin" ? "Create one" : "Sign in"}
            </button>
          </p>
          <p className="mt-8 text-center text-xs text-muted-foreground">
            <Link to="/" className="hover:underline">
              Back to {BRAND.name}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
