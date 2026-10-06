import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ShieldX, ScanEye, RefreshCw, Send, CheckCircle2, XCircle, Ban, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app/AppShell";
import { PageHeader, Section, StatCard, EmptyState, Stars } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { currentWorkspaceId } from "@/lib/seovale-db";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  draftRemovalReply,
  getScanSchedule,
  publishRemovalReply,
  scanReviewsForRemoval,
  updateRemovalCase,
  updateScanSchedule,
} from "@/lib/removal.functions";
import { cn } from "@/lib/utils";


function AppealReply({ caseId, onPublished }: { caseId: string; onPublished: () => void }) {
  const [reply, setReply] = useState("");
  const draft = useServerFn(draftRemovalReply);
  const publish = useServerFn(publishRemovalReply);

  const write = useMutation({
    mutationFn: async () => draft({ data: { caseId } }),
    onSuccess: (result: { reply: string }) => {
      setReply(result.reply);
      toast.success("Reply drafted");
    },
    onError: (error: unknown) =>
      toast.error(error instanceof Error ? error.message : "Could not write the reply."),
  });

  const send = useMutation({
    mutationFn: async () => publish({ data: { caseId, reply } }),
    onSuccess: (result: { postedToGoogle: boolean }) => {
      onPublished();
      toast.success(
        result.postedToGoogle ? "Reply published on Google" : "Reply saved — publish it on the platform",
      );
    },
    onError: (error: unknown) =>
      toast.error(error instanceof Error ? error.message : "Could not send the reply."),
  });

  return (
    <div className="mt-3 rounded-lg border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold">Public reply while the appeal is pending</span>
        <Button size="sm" variant="outline" onClick={() => write.mutate()} disabled={write.isPending}>
          {write.isPending ? <RefreshCw className="animate-spin" /> : <Sparkles />}
          {write.isPending ? "Writing…" : reply ? "Rewrite" : "Draft reply"}
        </Button>
      </div>
      {reply && (
        <>
          <Textarea
            className="mt-2 min-h-24 text-sm"
            value={reply}
            onChange={(event) => setReply(event.target.value)}
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => send.mutate()} disabled={send.isPending || reply.trim().length < 5}>
              <Send /> {send.isPending ? "Sending…" : "Send reply"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void navigator.clipboard.writeText(reply);
                toast.success("Reply copied");
              }}
            >
              Copy reply
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

export const Route = createFileRoute("/_authenticated/removals")({
  head: () => ({
    meta: [
      { title: "Review Removal — Seovale" },
      {
        name: "description",
        content:
          "Automatic policy scanning that flags fake, spam, abusive or off-topic reviews and tracks every removal request to its outcome.",
      },
      { property: "og:title", content: "Review Removal — Seovale" },
      {
        property: "og:description",
        content: "Scan reviews against platform policy and manage removal requests end to end.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: RemovalsPage,
});

type CaseRow = {
  id: string;
  review_id: string;
  violation_type: string;
  confidence: number;
  rationale: string;
  appeal_text: string | null;
  status: string;
  /**
   * The verified outcome, derived server-side from recheck evidence. The status
   * is only what a person asserted, so removal is read from here and never from
   * the status.
   */
  outcome: string | null;
  model: string | null;
  created_at: string;
  reviews: {
    author: string;
    rating: number;
    body: string;
    platform: string;
    location_name: string;
  } | null;
};

const violationLabels: Record<string, string> = {
  fake_or_incentivised: "Fake or incentivised",
  spam_or_advertising: "Spam or advertising",
  hate_or_harassment: "Hate or harassment",
  profanity_or_obscenity: "Profanity",
  off_topic: "Off topic",
  conflict_of_interest: "Conflict of interest",
  personal_information: "Personal information",
};

const statusTone: Record<string, string> = {
  flagged: "bg-warning-soft text-rating-foreground",
  submitted: "bg-info-soft text-info",
  approved: "bg-positive-soft text-positive",
  rejected: "bg-negative-soft text-negative",
  dismissed: "bg-muted text-muted-foreground",
};

const outcomeLabels: Record<string, string> = {
  removed: "Removed",
  retained: "Retained",
  unverified: "Unverified",
};

/**
 * What a case may truthfully be called.
 *
 * A status of "approved" only records that a member marked the case closed; it is
 * not evidence that the platform took the review down. So where the status would
 * otherwise read as removal, the verified outcome is shown instead. Every other
 * status keeps its existing representation, which is already truthful.
 */
function caseLabel(row: CaseRow): string {
  if (row.status !== "approved") return row.status;
  return outcomeLabels[row.outcome ?? ""] ?? "Unverified";
}

/**
 * Tone for the label above, reusing the tones already defined for the statuses so
 * no new styling is introduced: a verified removal keeps the positive tone, a
 * review still published takes the negative one, and anything unverified is muted.
 */
function caseTone(row: CaseRow): string | undefined {
  if (row.status !== "approved") return statusTone[row.status];
  if (row.outcome === "removed") return statusTone["approved"];
  if (row.outcome === "retained") return statusTone["rejected"];
  return statusTone["dismissed"];
}

const tabs = ["Flagged", "Submitted", "Resolved", "All"] as const;

function useRemovalCases() {
  return useQuery({
    queryKey: ["removal_cases"],
    queryFn: async (): Promise<CaseRow[]> => {
      const workspaceId = await currentWorkspaceId();
      const { data, error } = await supabase
        .from("removal_cases")
        .select(
          "id, review_id, violation_type, confidence, rationale, appeal_text, status, outcome, model, created_at, reviews(author, rating, body, platform, location_name)",
        )
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as CaseRow[];
    },
  });
}

function useLastScan() {
  return useQuery({
    queryKey: ["removal_scans", "latest"],
    queryFn: async () => {
      const workspaceId = await currentWorkspaceId();
      const { data, error } = await supabase
        .from("removal_scans")
        .select("reviews_checked, reviews_flagged, model, status, created_at")
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

const INTERVALS = [
  { value: 60, label: "Every hour" },
  { value: 180, label: "Every 3 hours" },
  { value: 360, label: "Every 6 hours" },
  { value: 720, label: "Every 12 hours" },
  { value: 1440, label: "Once a day" },
  { value: 10080, label: "Once a week" },
];

const BATCHES = [10, 20, 40, 60, 100, 120];

interface Schedule {
  canEdit: boolean;
  enabled: boolean;
  intervalMinutes: number;
  batchSize: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  pausedReason: string | null;
}

function ScanSchedule() {
  const qc = useQueryClient();
  const read = useServerFn(getScanSchedule);
  const save = useServerFn(updateScanSchedule);

  const { data } = useQuery({
    queryKey: ["removal_scan_schedule"],
    queryFn: async () => (await read()) as Schedule,
  });

  const update = useMutation({
    mutationFn: async (patch: {
      enabled?: boolean;
      intervalMinutes?: number;
      batchSize?: number;
      resume?: boolean;
    }) => save({ data: patch }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["removal_scan_schedule"] });
      toast.success("Automatic scan updated");
    },
    onError: (error: unknown) =>
      toast.error(error instanceof Error ? error.message : "Could not save the scan schedule."),
  });

  if (!data) return null;
  const disabled = !data.canEdit || update.isPending;

  return (
    <Section
      title="Automatic scanning"
      description="After new reviews sync, the scan runs on its own at the interval you choose."
    >
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex items-center gap-2 text-sm font-medium">
          <Switch
            checked={data.enabled}
            disabled={disabled}
            onCheckedChange={(enabled) => update.mutate({ enabled })}
          />
          {data.enabled ? "On" : "Off"}
        </label>

        <div className="min-w-44">
          <span className="mb-1 block text-xs font-semibold text-muted-foreground">How often</span>
          <Select
            value={String(data.intervalMinutes)}
            disabled={disabled}
            onValueChange={(value) => update.mutate({ intervalMinutes: Number(value) })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INTERVALS.map((option) => (
                <SelectItem key={option.value} value={String(option.value)}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="min-w-40">
          <span className="mb-1 block text-xs font-semibold text-muted-foreground">
            Reviews per run
          </span>
          <Select
            value={String(data.batchSize)}
            disabled={disabled}
            onValueChange={(value) => update.mutate({ batchSize: Number(value) })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BATCHES.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size} reviews
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="text-xs text-muted-foreground">
          <div>Last run: {data.lastRunAt ? new Date(data.lastRunAt).toLocaleString() : "—"}</div>
          <div>
            Next run:{" "}
            {data.enabled && data.nextRunAt ? new Date(data.nextRunAt).toLocaleString() : "—"}
          </div>
        </div>
      </div>

      {data.pausedReason && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs">
          <span className="font-semibold text-destructive">Paused: {data.pausedReason}</span>
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => update.mutate({ resume: true })}>
            Resume scanning
          </Button>
        </div>
      )}
    </Section>
  );
}

function RemovalsPage() {

  const [tab, setTab] = useState<(typeof tabs)[number]>("Flagged");
  const { data: cases = [], isLoading } = useRemovalCases();
  const { data: lastScan } = useLastScan();
  const qc = useQueryClient();
  const scan = useServerFn(scanReviewsForRemoval);
  const update = useServerFn(updateRemovalCase);
  const autoScanned = useRef(false);

  const runScan = useMutation({
    mutationFn: async () => scan({ data: {} }),
    onSuccess: (result: { checked: number; flagged: number }) => {
      void qc.invalidateQueries({ queryKey: ["removal_cases"] });
      void qc.invalidateQueries({ queryKey: ["removal_scans", "latest"] });
      if (result.checked === 0) toast.success("Every review has already been scanned.");
      else
        toast.success(
          `Scanned ${result.checked} reviews — ${result.flagged} flagged for removal.`,
        );
    },
    onError: (error: unknown) =>
      toast.error(error instanceof Error ? error.message : "Scan could not finish."),
  });

  const setStatus = useMutation({
    mutationFn: async (vars: { id: string; status: string }) =>
      update({ data: { id: vars.id, status: vars.status as never } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["removal_cases"] });
      toast.success("Case updated");
    },
    onError: (error: unknown) =>
      toast.error(error instanceof Error ? error.message : "Could not update the case."),
  });

  // Scan automatically the first time the page opens so new reviews are always assessed.
  useEffect(() => {
    if (autoScanned.current || isLoading) return;
    autoScanned.current = true;
    runScan.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading]);

  const visible = cases.filter((c) =>
    tab === "All"
      ? true
      : tab === "Flagged"
        ? c.status === "flagged"
        : tab === "Submitted"
          ? c.status === "submitted"
          : ["approved", "rejected", "dismissed"].includes(c.status),
  );

  const flagged = cases.filter((c) => c.status === "flagged").length;
  const submitted = cases.filter((c) => c.status === "submitted").length;
  // Counted from the verified outcome, never from the status: a case a member
  // marked closed is not a review the platform actually took down.
  const removed = cases.filter((c) => c.outcome === "removed").length;

  return (
    <AppShell>
      <PageHeader
        eyebrow="Reputation defence"
        title="Review Removal"
        description="Every review is scanned against platform content policy. Genuine criticism is never flagged — only reviews that break the rules."
        actions={
          <Button onClick={() => runScan.mutate()} disabled={runScan.isPending}>
            {runScan.isPending ? (
              <RefreshCw className="animate-spin" />
            ) : (
              <ScanEye />
            )}
            {runScan.isPending ? "Scanning…" : "Scan reviews"}
          </Button>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Flagged" value={String(flagged)} icon={ShieldX} />
        <StatCard label="Submitted" value={String(submitted)} icon={Send} />
        <StatCard label="Removed" value={String(removed)} icon={CheckCircle2} />
        <StatCard
          label="Last scan"
          value={lastScan ? `${lastScan.reviews_checked} checked` : "—"}
          icon={ScanEye}
          sub={lastScan ? `${lastScan.reviews_flagged} flagged` : "No scan yet"}
        />
      </div>

      <div className="mb-6">
        <ScanSchedule />
      </div>



      <Section
        title="Removal cases"
        description="Cases created by the automatic policy scan, with the appeal text you can send to the platform."
        bodyClassName="p-0"
        action={
          <div className="flex gap-1 rounded-lg bg-muted p-1">
            {tabs.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  "rounded-md px-3 py-1 text-xs font-semibold transition-colors",
                  tab === t ? "bg-card text-foreground shadow-xs" : "text-muted-foreground",
                )}
              >
                {t}
              </button>
            ))}
          </div>
        }
      >
        {visible.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={ShieldX}
              title={isLoading || runScan.isPending ? "Scanning your reviews…" : "Nothing breaks policy"}
              description={
                isLoading || runScan.isPending
                  ? "The policy scan is checking your latest reviews."
                  : "No review in this view breaks platform content policy. Honest negative feedback is deliberately never flagged."
              }
            />
          </div>
        ) : (
          <ul className="divide-y">
            {visible.map((c) => (
              <li key={c.id} className="px-5 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-negative-soft px-2 py-0.5 text-[11px] font-bold text-negative">
                    {violationLabels[c.violation_type] ?? c.violation_type}
                  </span>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px] font-bold capitalize",
                      caseTone(c) ?? "bg-muted text-muted-foreground",
                    )}
                  >
                    {caseLabel(c)}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {Math.round(Number(c.confidence) * 100)}% confidence
                  </span>
                  {c.reviews && (
                    <span className="text-[11px] text-muted-foreground">
                      {c.reviews.platform} · {c.reviews.location_name}
                    </span>
                  )}
                </div>

                {c.reviews && (
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-sm font-semibold">{c.reviews.author}</span>
                    <Stars value={c.reviews.rating} />
                  </div>
                )}
                {c.reviews && (
                  <p className="mt-1 text-sm text-muted-foreground">{c.reviews.body}</p>
                )}

                <p className="mt-3 text-sm">
                  <span className="font-semibold">Why it breaks policy: </span>
                  {c.rationale}
                </p>
                {c.appeal_text && (
                  <p className="mt-2 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                    {c.appeal_text}
                  </p>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  {c.appeal_text && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        void navigator.clipboard.writeText(c.appeal_text ?? "");
                        toast.success("Appeal text copied");
                      }}
                    >
                      Copy appeal
                    </Button>
                  )}
                  {c.status === "flagged" && (
                    <Button
                      size="sm"
                      onClick={() => setStatus.mutate({ id: c.id, status: "submitted" })}
                      disabled={setStatus.isPending}
                    >
                      <Send /> Mark submitted
                    </Button>
                  )}
                  {c.status === "submitted" && (
                    <>
                      <Button
                        size="sm"
                        onClick={() => setStatus.mutate({ id: c.id, status: "approved" })}
                        disabled={setStatus.isPending}
                      >
                        <CheckCircle2 /> Removed
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setStatus.mutate({ id: c.id, status: "rejected" })}
                        disabled={setStatus.isPending}
                      >
                        <XCircle /> Rejected
                      </Button>
                    </>
                  )}
                  {c.status !== "dismissed" && !["approved", "rejected"].includes(c.status) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setStatus.mutate({ id: c.id, status: "dismissed" })}
                      disabled={setStatus.isPending}
                    >
                      <Ban /> Dismiss
                    </Button>
                  )}
                </div>

                {["flagged", "submitted"].includes(c.status) && (
                  <AppealReply
                    caseId={c.id}
                    onPublished={() => void qc.invalidateQueries({ queryKey: ["removal_cases"] })}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </AppShell>
  );
}
