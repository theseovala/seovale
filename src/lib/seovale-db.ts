// Live data layer for Seovale — reviews, alerts, platforms, locations,
// competitors, reports and brand settings. All data is stored in the backend.
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type {
  Alert,
  Competitor,
  LocationRecord,
  PlatformId,
  Review,
  ReviewStatus,
  Sentiment,
} from "@/lib/domain";

export interface ConnectedPlatformRow {
  id: string;
  platform: string;
  display_name: string;
  account_ref: string | null;
  status: string;
  supports_oauth: boolean;
  last_synced_at: string | null;
  last_sync_error: string | null;
}

export interface AlertRulesRow {
  id: string;
  workspace_id: string;
  negative_rating_threshold: number;
  unanswered_hours: number;
  rating_drop_threshold: number;
  volume_spike_percent: number;
}

export async function currentWorkspaceId() {
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) throw authError ?? new Error("Not signed in");
  const { data, error } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", auth.user.id)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("No workspace is assigned to this account.");
  return data.workspace_id;
}

export function useCurrentWorkspace() {
  return useQuery({
    queryKey: ["current_workspace"],
    queryFn: async () => {
      const workspaceId = await currentWorkspaceId();
      const { data, error } = await supabase
        .from("workspaces")
        .select("id, name, slug")
        .eq("id", workspaceId)
        .single();
      if (error) throw error;
      return data;
    },
  });
}

function initialsOf(name: string) {
  const clean = name.replace(/^@/, "").trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return clean.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

export function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months === 1 ? "1 month ago" : `${months} months ago`;
}

export interface ReviewRow {
  id: string;
  platform: string;
  author: string;
  rating: number;
  sentiment: string;
  status: string;
  priority: string;
  location_name: string;
  title: string | null;
  body: string;
  tags: string[];
  unread: boolean;
  reply: string | null;
  replied_at: string | null;
  external_created_at: string;
}

export type LiveReview = Review & {
  external_created_at: string;
  replied_at: string | null;
};

function toReview(row: ReviewRow): LiveReview {
  return {
    id: row.id,
    external_created_at: row.external_created_at,
    replied_at: row.replied_at,
    platform: row.platform as PlatformId,
    author: row.author,
    initials: initialsOf(row.author),
    rating: row.rating,
    sentiment: row.sentiment as Sentiment,
    status: row.status as ReviewStatus,
    priority: row.priority as Review["priority"],
    location: row.location_name,
    date: relativeTime(row.external_created_at),
    ...(row.title ? { title: row.title } : {}),
    body: row.body,
    tags: row.tags ?? [],
    unread: row.unread,
    ...(row.reply ? { reply: row.reply } : {}),
  };
}

export interface AlertRow {
  id: string;
  kind: string;
  severity: string;
  title: string;
  detail: string;
  location_name: string;
  resolved: boolean;
  created_at: string;
}

const kindMap: Record<string, Alert["type"]> = {
  negative_review: "negative",
  rating_drop: "drop",
  volume_spike: "spike",
  unusual: "unusual",
  unresolved: "unresolved",
  suspicious_activity: "suspicious",
};

function toAlert(row: AlertRow): Alert {
  return {
    id: row.id,
    type: kindMap[row.kind] ?? "unusual",
    severity: row.severity as Alert["severity"],
    title: row.title,
    detail: row.detail,
    location: row.location_name,
    time: relativeTime(row.created_at),
    resolved: row.resolved,
  };
}

/** Subscribes to a table's Realtime changes and refetches the given query keys live. */
function useRealtimeTable(table: string, queryKeys: string[]) {
  const queryClient = useQueryClient();
  useEffect(() => {
    // Unique channel per mount: reusing a name can race with an async
    // removeChannel from a prior unmount and throw "cannot add callbacks
    // after subscribe()".
    const channel = supabase
      .channel(`live-${table}-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table }, () => {
        for (const key of queryKeys) queryClient.invalidateQueries({ queryKey: [key] });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, queryKeys.join(",")]);
}

export function useLiveReviews() {
  useRealtimeTable("reviews", ["reviews"]);
  return useQuery({
    queryKey: ["reviews"],
    queryFn: async (): Promise<LiveReview[]> => {
      const workspaceId = await currentWorkspaceId();
      const { data, error } = await supabase
        .from("reviews")
        .select(
          "id, platform, author, rating, sentiment, status, priority, location_name, title, body, tags, unread, reply, replied_at, external_created_at",
        )
        .eq("workspace_id", workspaceId)
        .neq("source", "seed")
        .order("external_created_at", { ascending: false });
      if (error) throw error;
      return (data as ReviewRow[]).map(toReview);
    },
  });
}

export function useLiveAlerts() {
  useRealtimeTable("alerts", ["alerts"]);
  return useQuery({
    queryKey: ["alerts"],
    queryFn: async (): Promise<Alert[]> => {
      const workspaceId = await currentWorkspaceId();
      const { data, error } = await supabase
        .from("alerts")
        .select("*")
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data as AlertRow[]).map(toAlert);
    },
  });
}

export function useConnectedPlatforms() {
  return useQuery({
    queryKey: ["connected_platforms"],
    queryFn: async (): Promise<ConnectedPlatformRow[]> => {
      const workspaceId = await currentWorkspaceId();
      const { data, error } = await supabase
        .from("connected_platforms")
        .select("*")
        .eq("workspace_id", workspaceId)
        .order("display_name");
      if (error) throw error;
      return data as ConnectedPlatformRow[];
    },
  });
}

export function useLocations() {
  return useQuery({
    queryKey: ["locations"],
    queryFn: async (): Promise<LocationRecord[]> => {
      const workspaceId = await currentWorkspaceId();
      const { data, error } = await supabase
        .from("locations")
        .select("id, name, city, country, manager")
        .eq("workspace_id", workspaceId)
        .order("name");
      if (error) throw error;
      return data as LocationRecord[];
    },
  });
}

export interface CompetitorRow {
  id: string;
  name: string;
  is_you: boolean;
  rating: number;
  review_count: number;
  sentiment_score: number;
  response_rate: number;
  trend: number;
  notes: string | null;
}

export function useCompetitors() {
  return useQuery({
    queryKey: ["competitors"],
    queryFn: async (): Promise<Competitor[]> => {
      const workspaceId = await currentWorkspaceId();
      const { data, error } = await supabase
        .from("competitors")
        .select("*")
        .eq("workspace_id", workspaceId)
        .order("is_you", { ascending: false });
      if (error) throw error;
      return (data as CompetitorRow[]).map((c) => ({
        id: c.id,
        name: c.name,
        rating: Number(c.rating),
        reviews: c.review_count,
        sentiment: c.sentiment_score,
        responseRate: c.response_rate,
        trend: Number(c.trend),
        score: Math.round(
          ((Number(c.rating) - 1) / 4) * 50 + c.sentiment_score * 0.3 + c.response_rate * 0.2,
        ),
        ...(c.notes ? { notes: c.notes } : {}),
        ...(c.is_you ? { you: true } : {}),
      }));
    },
  });
}

export interface BrandSettings {
  id: string;
  brand_name: string;
  industry: string;
  website: string | null;
  reply_tone: string;
  reply_signature: string;
  alert_email: string | null;
  negative_review_alerts: boolean;
  weekly_digest: boolean;
}

export function useBrandSettings() {
  return useQuery({
    queryKey: ["brand_settings"],
    queryFn: async (): Promise<BrandSettings | null> => {
      const workspaceId = await currentWorkspaceId();
      const { data, error } = await supabase.from("brand_settings").select("*").eq("workspace_id", workspaceId).limit(1).maybeSingle();
      if (error) throw error;
      return data as BrandSettings | null;
    },
  });
}

export function useUpdateBrandSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<BrandSettings> }) => {
      const workspaceId = await currentWorkspaceId();
      const { error } = await supabase.from("brand_settings").update(patch).eq("id", id).eq("workspace_id", workspaceId);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["brand_settings"] }),
  });
}

export interface ReportRow {
  id: string;
  title: string;
  period: string;
  scope: string;
  summary: string | null;
  status: string;
  created_at: string;
}

export function useReports() {
  return useQuery({
    queryKey: ["reports"],
    queryFn: async (): Promise<ReportRow[]> => {
      const workspaceId = await currentWorkspaceId();
      const { data, error } = await supabase
        .from("reports")
        .select("*")
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as ReportRow[];
    },
  });
}

export function useProfile() {
  return useQuery({
    queryKey: ["profile"],
    queryFn: async () => {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) return null;
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", auth.user.id)
        .maybeSingle();
      if (error) throw error;
      return (data ?? { id: auth.user.id, email: auth.user.email, full_name: null, job_title: null }) as {
        id: string;
        email: string | null;
        full_name: string | null;
        job_title: string | null;
      };
    },
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: { full_name?: string; job_title?: string }) => {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) throw new Error("Not signed in");
      const { error } = await supabase
        .from("profiles")
        .upsert({ id: auth.user.id, email: auth.user.email ?? null, ...patch });
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["profile"] }),
  });
}

export function usePublishReply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reply }: { id: string; reply: string }) => {
      const workspaceId = await currentWorkspaceId();
      const { data: auth } = await supabase.auth.getUser();
      const { error } = await supabase
        .from("reviews")
        .update({
          reply,
          replied_at: new Date().toISOString(),
          replied_by: auth.user?.id ?? null,
          status: "replied",
          unread: false,
        })
        .eq("id", id)
        .eq("workspace_id", workspaceId);
      if (error) throw error;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["reviews"] });
      void qc.invalidateQueries({ queryKey: ["alerts"] });
    },
  });
}

export function useUpdateReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: Partial<{ status: string; priority: string; unread: boolean }>;
    }) => {
      const workspaceId = await currentWorkspaceId();
      const { error } = await supabase.from("reviews").update(patch).eq("id", id).eq("workspace_id", workspaceId);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["reviews"] }),
  });
}

export function useResolveAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, resolved }: { id: string; resolved: boolean }) => {
      const workspaceId = await currentWorkspaceId();
      const { error } = await supabase.from("alerts").update({ resolved }).eq("id", id).eq("workspace_id", workspaceId);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["alerts"] }),
  });
}

export function useDisconnectPlatform() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const workspaceId = await currentWorkspaceId();
      const { error } = await supabase
        .from("connected_platforms")
        .update({ status: "disconnected", last_synced_at: null, account_ref: null })
        .eq("id", id)
        .eq("workspace_id", workspaceId);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["connected_platforms"] }),
  });
}

export function useAlertRules() {
  return useQuery({
    queryKey: ["alert_rules"],
    queryFn: async (): Promise<AlertRulesRow | null> => {
      const workspaceId = await currentWorkspaceId();
      const { data, error } = await supabase
        .from("alert_rules")
        .select("*")
        .eq("workspace_id", workspaceId)
        .maybeSingle();
      if (error) throw error;
      return data as AlertRulesRow | null;
    },
  });
}

export function useUpdateAlertRules() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<AlertRulesRow> }) => {
      const workspaceId = await currentWorkspaceId();
      const { error } = await supabase.from("alert_rules").update(patch).eq("id", id).eq("workspace_id", workspaceId);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["alert_rules"] }),
  });
}
