import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { BrandMark } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/reset-password")({
  ssr: false,
  head: () => ({ meta: [
    { title: "Reset password — Seovale" },
    { name: "description", content: "Set a new password for your Seovale workspace account." },
    { property: "og:title", content: "Reset password — Seovale" },
    { property: "og:description", content: "Securely restore access to your Seovale workspace." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) setMessage(error.message);
    else void navigate({ to: "/dashboard", replace: true });
  }
  return <main className="flex min-h-screen items-center justify-center bg-muted/30 px-5 py-12">
    <section className="w-full max-w-sm">
      <Link to="/" className="mb-8 flex items-center gap-3"><BrandMark /><span className="font-display text-lg font-extrabold">Seovale</span></Link>
      <h1 className="font-display text-2xl font-bold">Choose a new password</h1>
      <p className="mt-1 text-sm text-muted-foreground">Use at least eight characters.</p>
      <form className="mt-6 space-y-4" onSubmit={submit}>
        <div className="space-y-1.5"><Label htmlFor="new-password">New password</Label><Input id="new-password" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} /></div>
        {message && <p className="rounded-lg bg-negative-soft px-3 py-2 text-sm text-negative">{message}</p>}
        <Button className="w-full" disabled={busy}>{busy && <Loader2 className="animate-spin" />}Update password</Button>
      </form>
    </section>
  </main>;
}