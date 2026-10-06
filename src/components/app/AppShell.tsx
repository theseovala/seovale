import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Search,
  Bell,
  ChevronsUpDown,
  Menu,
  LogOut,
  UserRound,
  PanelLeftClose,
  PanelLeftOpen,
  LifeBuoy,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useApp, ALL_LOCATIONS } from "@/lib/app-context";
import { BRAND } from "@/lib/domain";
import { useLiveAlerts, useLiveReviews, useProfile } from "@/lib/seovale-db";
import { supabase } from "@/integrations/supabase/client";
import { BrandMark } from "./primitives";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export { navItems } from "./nav-items";
import { navItems, navGroups } from "./nav-items";
import { CommandPalette, useCommandPalette } from "./CommandPalette";
import { NotificationBell } from "./NotificationBell";

function NavList({
  collapsed,
  onNavigate,
  counts,
}: {
  collapsed: boolean;
  onNavigate?: (() => void) | undefined;
  counts: Record<string, number>;
}) {
  return (
    <nav className={cn("flex flex-col gap-3", collapsed ? "px-2" : "px-3")}>
      {navGroups.map((group) => (
        <div key={group.label} className="flex flex-col gap-0.5">
          {!collapsed && (
            <p className="px-3 pb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-sidebar-muted/70">
              {group.label}
            </p>
          )}
          {collapsed && <span className="mx-2 mb-1 h-px bg-sidebar-border/60" />}
          {group.ids.map((id) => {
            const item = navItems.find((n) => n.id === id)!;
            const badge = counts[item.id];
            const urgent = item.id === "alerts";
            const link = (
              <Link
                key={item.id}
                to={item.to}
                onClick={onNavigate}
                className={cn(
                  "group relative flex items-center gap-2.5 rounded-lg text-[13px] font-medium text-sidebar-muted outline-none transition-all duration-200",
                  "hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent/70",
                  collapsed ? "justify-center px-0 py-2" : "px-2.5 py-2 hover:translate-x-0.5",
                )}
                activeProps={{
                  className:
                    "bg-sidebar-accent text-sidebar-accent-foreground shadow-[var(--shadow-sidebar-active)] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-r-full before:bg-sidebar-primary [&_[data-icon]]:bg-sidebar-primary/20 [&_[data-icon]]:text-sidebar-primary",
                }}
              >
                <span
                  data-icon
                  className="grid size-7 shrink-0 place-items-center rounded-md bg-sidebar-accent/40 text-current transition-colors duration-200 group-hover:bg-sidebar-primary/15"
                >
                  <item.icon className="size-[15px]" strokeWidth={2} />
                </span>
                {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
                {!collapsed && !!badge && (
                  <span
                    className={cn(
                      "num rounded-full px-1.5 py-0.5 text-[10px] font-bold",
                      urgent
                        ? "bg-negative text-destructive-foreground"
                        : "bg-sidebar-primary/20 text-sidebar-primary",
                    )}
                  >
                    {badge}
                  </span>
                )}
                {collapsed && !!badge && (
                  <span
                    className={cn(
                      "absolute right-1.5 top-1 size-2 rounded-full ring-2 ring-sidebar",
                      urgent ? "bg-negative" : "bg-sidebar-primary",
                    )}
                  />
                )}
              </Link>
            );
            if (!collapsed) return link;
            return (
              <Tooltip key={item.id}>
                <TooltipTrigger asChild>{link}</TooltipTrigger>
                <TooltipContent side="right" className="font-medium">
                  {item.label}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function SidebarInner({
  collapsed,
  onNavigate,
  counts,
}: {
  collapsed: boolean;
  onNavigate?: (() => void) | undefined;
  counts: Record<string, number>;
}) {
  const { brandName } = useApp();
  return (
    <div className="flex h-full flex-col border-r border-sidebar-border/70">
      <div
        className={cn(
          "flex min-h-14 items-center gap-2.5 border-b border-sidebar-border/60 py-1",
          collapsed ? "justify-center px-0" : "px-4",
        )}
      >
        <BrandMark light />
        {!collapsed && (
          <div className="min-w-0 leading-tight">
            <p className="truncate font-display text-[15px] font-extrabold tracking-tight text-sidebar-accent-foreground">
              {BRAND.name}
            </p>
            <p className="truncate text-[10px] font-medium tracking-wide text-sidebar-muted">
              Reputation Command Center
            </p>
          </div>
        )}
      </div>
      {!collapsed && (
        <div className="mx-3 mt-3 rounded-lg border border-sidebar-border/80 bg-sidebar-accent/40 px-3 py-2 shadow-[var(--shadow-sidebar-active)]">
          <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-sidebar-muted/80">
            Workspace
          </p>
          <p className="truncate text-xs font-semibold text-sidebar-accent-foreground">{brandName}</p>
        </div>
      )}
      <div className="scrollbar-thin flex-1 overflow-y-auto py-3">
        <NavList collapsed={collapsed} onNavigate={onNavigate} counts={counts} />
      </div>
      <div
        className={cn(
          "border-t border-sidebar-border/60 py-3",
          collapsed ? "px-2 text-center" : "px-4",
        )}
      >
        {collapsed ? (
          <span className="text-[10px] font-bold text-sidebar-muted">SV</span>
        ) : (
          <p className="text-[10px] leading-relaxed text-sidebar-muted">
            {BRAND.name} — {BRAND.tagline}
          </p>
        )}
      </div>
    </div>
  );
}

function TopBar({
  onMenu,
  collapsed,
  onToggle,
  onSearch,
}: {
  onMenu: () => void;
  collapsed: boolean;
  onToggle: () => void;
  onSearch: () => void;
}) {
  const { location, setLocation, locationNames, brandName } = useApp();
  const { data: alerts } = useLiveAlerts();
  const { data: profile } = useProfile();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const open = (alerts ?? []).filter((a) => !a.resolved);

  const name = profile?.full_name || profile?.email || "Your account";
  const initials = name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");

  async function signOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    void navigate({ to: "/auth", replace: true });
  }

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-1.5 border-b bg-background/85 px-3 shadow-[0_1px_0_0_color-mix(in_oklab,var(--border)_60%,transparent)] backdrop-blur-xl md:gap-2 md:px-5">
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={onMenu} aria-label="Open navigation">
        <Menu />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="hidden lg:inline-flex"
        onClick={onToggle}
        aria-label="Toggle sidebar"
      >
        {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex max-w-[220px] items-center gap-2 rounded-lg border bg-card px-3 py-1.5 text-left text-sm shadow-xs transition-colors hover:bg-accent md:max-w-xs">
            <span className="grid size-6 shrink-0 place-items-center rounded-md bg-gradient-brand text-[10px] font-bold text-primary-foreground">
              {brandName.slice(0, 2).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {brandName}
              </span>
              <span className="block truncate font-semibold">{location}</span>
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel className="text-xs text-muted-foreground">Switch location</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={location} onValueChange={setLocation}>
            {locationNames.map((l) => (
              <DropdownMenuRadioItem key={l} value={l} className="gap-2">
                <span className="flex-1">{l}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <button
        type="button"
        onClick={onSearch}
        className="press ml-auto hidden h-9 w-full max-w-sm items-center gap-2 rounded-lg border bg-card pl-3 pr-2 text-sm text-muted-foreground transition-colors hover:bg-accent md:flex"
      >
        <Search className="size-4 shrink-0" />
        <span className="flex-1 truncate text-left">Search pages and scans…</span>
        <kbd className="rounded border bg-muted px-1.5 py-0.5 text-[10px] font-semibold">⌘K</kbd>
      </button>
      <Button
        variant="ghost"
        size="icon"
        className="ml-auto md:hidden"
        onClick={onSearch}
        aria-label="Search"
      >
        <Search />
      </Button>

      <div className="flex items-center gap-1 md:ml-2">
        <Button variant="ghost" size="icon" asChild aria-label="Support and help">
          <Link to="/support">
            <LifeBuoy />
          </Link>
        </Button>
        <NotificationBell />


        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="ml-1 flex items-center gap-2 rounded-full border bg-card p-1 pr-1 transition-colors hover:bg-accent md:pr-3">
              <span className="grid size-7 place-items-center rounded-full bg-gradient-brand text-xs font-bold text-primary-foreground">
                {initials || "?"}
              </span>
              <span className="hidden text-left leading-tight md:block">
                <span className="block max-w-[140px] truncate text-xs font-semibold">{name}</span>
                <span className="block text-[10px] text-muted-foreground">
                  {profile?.job_title || "Team member"}
                </span>
              </span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuLabel>
              <p className="text-sm font-semibold">{profile?.full_name || "Your account"}</p>
              <p className="text-xs font-normal text-muted-foreground">{profile?.email}</p>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/settings">
                <UserRound /> Account settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void signOut()}>
              <LogOut /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

/** Breadcrumb trail built from the real route table — never a decorative label. */
function Breadcrumbs({ pathname }: { pathname: string }) {
  const item = navItems.find((n) => pathname.startsWith(n.to));
  if (!item) return null;
  return (
    <nav aria-label="Breadcrumb" className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground">
      <Link to="/dashboard" className="transition-colors hover:text-foreground">
        Home
      </Link>
      <span aria-hidden>/</span>
      <span className="font-medium text-foreground">{item.label}</span>
    </nav>
  );
}

const SIDEBAR_KEY = "seovale:sidebar-collapsed";

export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: reviews } = useLiveReviews();
  const { data: alerts } = useLiveAlerts();
  const palette = useCommandPalette();


  // Restore the user's choice, and auto-collapse on narrow/half-screen laptops.
  useEffect(() => {
    const stored = window.localStorage.getItem(SIDEBAR_KEY);
    const narrow = window.matchMedia("(max-width: 1279px)");
    if (stored !== null) setCollapsed(stored === "1");
    else setCollapsed(narrow.matches);
    const onChange = (e: MediaQueryListEvent) => {
      if (window.localStorage.getItem(SIDEBAR_KEY) === null) setCollapsed(e.matches);
    };
    narrow.addEventListener("change", onChange);
    return () => narrow.removeEventListener("change", onChange);
  }, []);

  function toggleSidebar() {
    setCollapsed((c) => {
      window.localStorage.setItem(SIDEBAR_KEY, c ? "0" : "1");
      return !c;
    });
  }

  const counts: Record<string, number> = {
    reviews: (reviews ?? []).filter((r) => r.unread).length,
    responses: (reviews ?? []).filter((r) => r.status === "pending" || r.status === "escalated").length,
    alerts: (alerts ?? []).filter((a) => !a.resolved).length,
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="bg-ambient flex min-h-screen w-full overflow-x-clip bg-background">
        <aside
          className={cn(
            "sticky top-0 hidden h-screen shrink-0 bg-sidebar text-sidebar-foreground transition-[width] duration-300 ease-out lg:block",
            collapsed ? "w-[68px]" : "w-[248px] xl:w-[264px]",
          )}
        >
          <SidebarInner collapsed={collapsed} counts={counts} />
        </aside>

        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent
            side="left"
            className="w-[276px] border-sidebar-border bg-sidebar p-0 text-sidebar-foreground [&>button]:text-sidebar-foreground"
          >
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SidebarInner collapsed={false} counts={counts} onNavigate={() => setMobileOpen(false)} />
          </SheetContent>
        </Sheet>

        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            onMenu={() => setMobileOpen(true)}
            collapsed={collapsed}
            onToggle={toggleSidebar}
            onSearch={() => palette.setOpen(true)}
          />
          <CommandPalette open={palette.open} onOpenChange={palette.setOpen} />
          <main
            key={pathname}
            className="animate-fade flex-1 px-3 py-4 sm:px-4 md:px-5 md:py-5 lg:px-6 2xl:px-8"
          >
            <div className="mx-auto w-full min-w-0 max-w-[1440px] 2xl:max-w-[1720px]">
              <Breadcrumbs pathname={pathname} />
              {children}
            </div>
          </main>
          <footer className="flex flex-col gap-1.5 border-t px-4 py-3 text-[11px] text-muted-foreground md:flex-row md:items-center md:justify-between md:px-6">
            <p>
              <span className="font-semibold text-foreground">{BRAND.name}</span> — Your reputation, one
              command center.
            </p>
            <p>All figures are calculated from your connected review data.</p>
          </footer>
        </div>
      </div>
    </TooltipProvider>
  );
}
