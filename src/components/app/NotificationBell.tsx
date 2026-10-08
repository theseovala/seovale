// Header notification inbox. Every row is a real stored event; nothing is
// generated client-side.
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Bell, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useRealtimeInvalidate } from "@/hooks/use-realtime";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  deleteNotification,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/lib/notifications.functions";

const DOT: Record<string, string> = {
  critical: "bg-negative",
  warning: "bg-warning",
  success: "bg-positive",
  info: "bg-info",
};

function since(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function NotificationBell() {
  const queryClient = useQueryClient();
  const load = useServerFn(listNotifications);
  const readOne = useServerFn(markNotificationRead);
  const readAll = useServerFn(markAllNotificationsRead);
  const remove = useServerFn(deleteNotification);

  // New notifications arrive as a server push, not on a timer.
  useRealtimeInvalidate("notifications-inbox", ["notifications"], [["notifications"]]);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => load(),
    // Realtime pushes new notifications; the slow poll is only a safety net.
    refetchInterval: 300_000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["notifications"] });
  const readOneMutation = useMutation({
    mutationFn: (id: string) => readOne({ data: { id } }),
    onSuccess: invalidate,
  });
  const readAllMutation = useMutation({ mutationFn: () => readAll(), onSuccess: invalidate });
  const removeMutation = useMutation({
    mutationFn: (id: string) => remove({ data: { id } }),
    onSuccess: invalidate,
  });

  const items = data?.items ?? [];
  const unread = data?.unread ?? 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
          <Bell />
          {unread > 0 && (
            <span className="absolute right-2 top-2 size-2 rounded-full bg-negative animate-pulse-dot" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-88 max-w-[calc(100vw-2rem)] p-0">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <p className="font-display text-sm font-bold">Notifications</p>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{unread} unread</span>
            {unread > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={readAllMutation.isPending}
                onClick={(e) => {
                  e.preventDefault();
                  readAllMutation.mutate();
                }}
              >
                <Check className="mr-1 size-3" /> Mark all read
              </Button>
            )}
          </div>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {isLoading && (
            <p className="px-4 py-6 text-center text-xs text-muted-foreground">Loading…</p>
          )}
          {isError && (
            <p className="px-4 py-6 text-center text-xs text-negative">
              Notifications could not be loaded.
            </p>
          )}
          {!isLoading && !isError && items.length === 0 && (
            <p className="px-4 py-6 text-center text-xs text-muted-foreground">
              No notifications yet. They appear when a scan finishes or a connection fails.
            </p>
          )}
          {items.map((item) => (
            <div
              key={item.id}
              className={cn(
                "group flex items-start gap-3 border-b px-4 py-3 last:border-0",
                !item.readAt && "bg-accent/30",
              )}
            >
              <span
                className={cn(
                  "mt-1.5 size-2 shrink-0 rounded-full",
                  DOT[item.severity] ?? "bg-info",
                )}
              />
              <div className="min-w-0 flex-1">
                {item.entityType === "scan" && item.entityId ? (
                  <Link
                    to="/scans"
                    search={{ scan: item.entityId }}
                    onClick={() => !item.readAt && readOneMutation.mutate(item.id)}
                    className="block truncate text-sm font-semibold hover:underline"
                  >
                    {item.title}
                  </Link>
                ) : (
                  <p className="truncate text-sm font-semibold">{item.title}</p>
                )}
                {item.message && (
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                    {item.message}
                  </p>
                )}
                <p className="mt-1 text-[11px] text-muted-foreground">{since(item.createdAt)}</p>
              </div>
              <div className="flex shrink-0 flex-col gap-1">
                {!item.readAt && (
                  <button
                    type="button"
                    aria-label="Mark as read"
                    className="rounded p-1 text-muted-foreground hover:bg-accent"
                    onClick={() => readOneMutation.mutate(item.id)}
                  >
                    <Check className="size-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  aria-label="Delete notification"
                  className="rounded p-1 text-muted-foreground hover:bg-accent"
                  onClick={() => removeMutation.mutate(item.id)}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
        <Link
          to="/alerts"
          className="block border-t px-4 py-2.5 text-center text-xs font-semibold text-primary hover:bg-accent/60"
        >
          Open Alert Center
        </Link>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
