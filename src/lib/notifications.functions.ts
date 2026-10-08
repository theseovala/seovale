// Notifications are written only by real backend events (scan finished, scan
// failed, integration error, security alert, licence expiry). Nothing is
// generated for display purposes.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface AppNotification {
  id: string;
  type: string;
  severity: "info" | "success" | "warning" | "critical";
  title: string;
  message: string | null;
  entityType: string | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
}

async function workspaceId(supabase: import("./backend-types").DatabaseClient, userId: string) {
  const { data } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  if (!data) throw new Error("No workspace found for this account.");
  return data.workspace_id as string;
}

export const listNotifications = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ items: AppNotification[]; unread: number }> => {
    const supabase = context.supabase;
    const ws = await workspaceId(supabase, context.userId);
    const { data, error } = await supabase
      .from("notifications")
      .select("id,type,severity,title,message,entity_type,entity_id,read_at,created_at")
      .eq("workspace_id", ws)
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) throw new Error(error.message);
    const items = (data ?? []).map((row): AppNotification => ({
      id: row.id,
      type: row.type,
      severity:
        row.severity === "success" || row.severity === "warning" || row.severity === "critical"
          ? row.severity
          : "info",
      title: row.title,
      message: row.message,
      entityType: row.entity_type,
      entityId: row.entity_id,
      readAt: row.read_at,
      createdAt: row.created_at,
    }));
    return { items, unread: items.filter((n) => !n.readAt).length };
  });

export const markNotificationRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", data.id)
      .is("read_at", null);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const markAllNotificationsRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const ws = await workspaceId(context.supabase, context.userId);
    const { error } = await context.supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("workspace_id", ws)
      .is("read_at", null);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteNotification = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("notifications").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
