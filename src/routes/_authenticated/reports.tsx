import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, FileText, Loader2, Sparkles } from "lucide-react";
import { AreaChart, Area, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip } from "recharts";
import { AppShell } from "@/components/app/AppShell";
import { PageHeader, Section, Stars, Trend, PlatformIcon, EmptyState } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useApp } from "@/lib/app-context";
import { useReports, useLiveReviews } from "@/lib/seovale-db";
import { monthlyTrend, platformPerformance, locationStats } from "@/lib/analytics";
import { platforms } from "@/lib/domain";
import { generateReport } from "@/lib/ai.functions";
import { exportReportPdf } from "@/lib/report-export.functions";

export const Route = createFileRoute("/_authenticated/reports")({
  head: () => ({
    meta: [
      { title: "Reputation Reports — Seovale" },
      {
        name: "description",
        content:
          "Generate AI-written reputation reports and review executive summaries, platform performance, trends and location comparison.",
      },
      { property: "og:title", content: "Reputation Reports — Seovale" },
      { property: "og:description", content: "Board-ready reputation reporting in one click." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ReportsPage,
});

const PERIODS = ["This week", "This month", "This quarter", "This year"];

function ReportsPage() {
  const { locationNames } = useApp();
  const { data: reports, isLoading: loadingReports } = useReports();
  const { data: reviews, isLoading: loadingReviews } = useLiveReviews();
  const [period, setPeriod] = useState(PERIODS[1]!);
  const [scope, setScope] = useState(locationNames[0] ?? "All locations");
  const [lastSummary, setLastSummary] = useState<string | null>(null);

  const generateReportFn = useServerFn(generateReport);
  const exportReportFn = useServerFn(exportReportPdf);
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => generateReportFn({ data: { period, scope } }),
    onSuccess: (res) => {
      setLastSummary(res.summary);
      toast.success("Report generated");
      void qc.invalidateQueries({ queryKey: ["reports"] });
    },
    onError: (err: Error) => toast.error(err.message || "Could not generate report"),
  });
  const exportMutation = useMutation({
    mutationFn: (id: string) => exportReportFn({ data: { id } }),
    onSuccess: ({ pdfBase64, fileName }) => {
      const bytes = Uint8Array.from(atob(pdfBase64), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success("PDF downloaded");
    },
    onError: (err: Error) => toast.error(err.message || "Could not export report"),
  });

  const trend = monthlyTrend(reviews ?? [], 6);
  const platformStats = platformPerformance(reviews ?? []);
  const locStats = locationStats(reviews ?? []);

  return (
    <AppShell>
      <PageHeader
        eyebrow="Report"
        title="Reports"
        description="Generate AI-written reputation reports from your live review data, formatted for presentation."
      />

      <Section className="mb-4" title="Generate a report" description="Pick a period and scope; the summary is written from your stored reviews">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <p className="mb-1.5 text-xs font-semibold text-muted-foreground">Period</p>
            <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PERIODS.map((p) => (
                  <SelectItem key={p} value={p}>{p}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-semibold text-muted-foreground">Scope</p>
            <Select value={scope} onValueChange={setScope}>
              <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                {locationNames.map((l) => (
                  <SelectItem key={l} value={l}>{l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending || loadingReviews || !reviews?.length}>
            {mutation.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />}
            Generate report
          </Button>
        </div>

        {lastSummary && (
          <div className="mt-4 whitespace-pre-line rounded-xl border bg-muted/40 p-4 text-sm leading-relaxed">
            {lastSummary}
          </div>
        )}
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Rating & score trend" description="Last 6 months, all reviews">
          {!loadingReviews && (!reviews || reviews.length === 0) ? (
            <EmptyState icon={FileText} title="No verified review data" description="Connect and sync a review source before generating reports or trends." />
          ) : (
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trend} margin={{ left: -20, right: 8, top: 8 }}>
                <defs>
                  <linearGradient id="rep" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="month" tickLine={false} axisLine={false} fontSize={12} stroke="var(--muted-foreground)" />
                <YAxis domain={[0, 5]} tickLine={false} axisLine={false} fontSize={12} stroke="var(--muted-foreground)" />
                <RTooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 12, fontSize: 12 }} />
                <Area type="monotone" dataKey="rating" stroke="var(--chart-1)" strokeWidth={2.5} fill="url(#rep)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          )}
        </Section>

        <Section title="Platform performance" bodyClassName="p-0">
          {loadingReviews ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
          ) : platformStats.length === 0 ? (
            <p className="p-5 text-sm text-muted-foreground">No review data yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-b-xl border-t">
              <table className="w-full min-w-[480px] text-sm">
                <thead>
                  <tr className="border-b bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-4 py-2.5 font-semibold">Platform</th>
                    <th className="px-4 py-2.5 font-semibold">Rating</th>
                    <th className="px-4 py-2.5 font-semibold">Reviews</th>
                    <th className="px-4 py-2.5 font-semibold">Response</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {platformStats.map((p) => (
                    <tr key={p.id}>
                      <td className="px-4 py-2.5"><span className="flex items-center gap-2 font-medium"><PlatformIcon id={p.id} size="sm" />{platforms[p.id].name}</span></td>
                      <td className="px-4 py-2.5"><span className="flex items-center gap-2"><span className="tabular-nums">{p.rating}</span><Stars value={p.rating} size={10} /></span></td>
                      <td className="px-4 py-2.5 tabular-nums">{p.reviews.toLocaleString()}</td>
                      <td className="px-4 py-2.5 tabular-nums">{p.response}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>

      <Section className="mt-4" title="Location comparison">
        {locStats.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No locations with reviews yet.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {locStats.map((l) => (
              <div key={l.name} className="rounded-xl border p-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold">{l.name}</p>
                  <Trend value={l.trend} suffix="" />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{l.reviews.toLocaleString()} reviews · {l.rating}★ · {l.responseRate}% answered</p>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-gradient-brand" style={{ width: `${l.score}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section className="mt-4" title="Report library" description="Reports generated for this workspace" bodyClassName="p-0">
        {loadingReports ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
        ) : !reports || reports.length === 0 ? (
          <EmptyState icon={FileText} title="No reports yet" description="Generate your first report above to see it saved here." />
        ) : (
          <ul className="divide-y">
            {reports.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start gap-3 px-5 py-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent text-primary"><FileText className="size-5" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{r.title}</span>
                  <span className="block text-xs text-muted-foreground">{r.period} · {r.scope}</span>
                  {r.summary && <span className="mt-1 block whitespace-pre-line text-xs text-muted-foreground line-clamp-3">{r.summary}</span>}
                </span>
                <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${r.status === "ready" ? "bg-positive-soft text-positive" : "bg-info-soft text-info"}`}>{r.status}</span>
                <Button size="icon" variant="ghost" title="Download PDF" disabled={exportMutation.isPending} onClick={() => exportMutation.mutate(r.id)}>
                  {exportMutation.isPending ? <Loader2 className="animate-spin" /> : <Download />}
                  <span className="sr-only">Download PDF</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </AppShell>
  );
}
