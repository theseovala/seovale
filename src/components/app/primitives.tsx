import { useEffect, useRef, type ReactNode } from "react";
import { Star, TrendingUp, TrendingDown, Minus, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { BRAND, platforms, type PlatformId, type Sentiment, type ReviewStatus } from "@/lib/domain";
import darkCoinAsset from "@/assets/seovale-coin-dark.jpg";
import lightCoinAsset from "@/assets/seovale-coin-light.jpg";
import { Button } from "@/components/ui/button";

/* ---------- Page header ---------- */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between animate-fade">
      <div>
        {eyebrow && (
          <p className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-primary">
            {eyebrow}
          </p>
        )}
        <h1 className="font-display text-[22px] font-bold tracking-tight text-foreground md:text-[28px]">
          {title}
        </h1>
        {description && (
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ---------- Stars ---------- */
export function Stars({
  value,
  size = 14,
  className,
}: {
  value: number;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={cn("inline-flex items-center gap-0.5", className)}
      aria-label={`${value} out of 5 stars`}
    >
      {[1, 2, 3, 4, 5].map((i) => {
        const fill = Math.max(0, Math.min(1, value - (i - 1)));
        return (
          <span key={i} className="relative inline-block" style={{ width: size, height: size }}>
            <Star
              className="absolute inset-0 text-border"
              style={{ width: size, height: size }}
              strokeWidth={1.5}
            />
            <span className="absolute inset-0 overflow-hidden" style={{ width: `${fill * 100}%` }}>
              <Star
                className="fill-rating text-rating"
                style={{ width: size, height: size }}
                strokeWidth={1.5}
              />
            </span>
          </span>
        );
      })}
    </span>
  );
}

/* ---------- Trend ---------- */
export function Trend({
  value,
  suffix = "%",
  className,
}: {
  value: number;
  suffix?: string;
  className?: string;
}) {
  const Icon = value > 0 ? TrendingUp : value < 0 ? TrendingDown : Minus;
  const tone = value > 0 ? "text-positive" : value < 0 ? "text-negative" : "text-muted-foreground";
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-semibold", tone, className)}>
      <Icon className="size-3.5" />
      {value > 0 ? "+" : ""}
      {value}
      {suffix}
    </span>
  );
}

/* ---------- Stat card ---------- */
export function StatCard({
  label,
  value,
  sub,
  trend,
  icon: Icon,
  tone = "default",
  children,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  trend?: number;
  icon?: LucideIcon;
  tone?: "default" | "primary" | "rating" | "positive" | "negative";
  children?: ReactNode;
}) {
  const iconTone = {
    default: "bg-secondary text-secondary-foreground",
    primary: "bg-accent text-primary",
    rating: "bg-rating-soft text-rating-foreground",
    positive: "bg-positive-soft text-positive",
    negative: "bg-negative-soft text-negative",
  }[tone];
  return (
    <div className="card-elevated card-interactive surface-sheen p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        {Icon && (
          <span
            className={cn("icon-tile grid size-8 shrink-0 place-items-center rounded-lg", iconTone)}
          >
            <Icon className="size-4" />
          </span>
        )}
      </div>
      <div className="mt-2 flex items-end gap-2.5">
        <span className="num font-display text-[28px] font-bold leading-none tracking-tight text-foreground">
          {value}
        </span>
        {trend !== undefined && <Trend value={trend} className="mb-0.5" />}
      </div>
      {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
      {children}
    </div>
  );
}

/* ---------- Score ring ---------- */
export function ScoreRing({
  score,
  size = 132,
  stroke = 10,
  label = "Reputation score",
}: {
  score: number;
  size?: number;
  stroke?: number;
  label?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const tone =
    score >= 85
      ? "var(--positive)"
      : score >= 70
        ? "var(--primary-glow)"
        : score >= 55
          ? "var(--warning)"
          : "var(--negative)";
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.15}
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c - (c * score) / 100}
          style={{ transition: "stroke-dashoffset 1.2s cubic-bezier(0.22,1,0.36,1)" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="num font-display text-3xl font-bold leading-none text-current">
          {score}
        </span>
        <span className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-current opacity-70">
          {label}
        </span>
      </div>
    </div>
  );
}

/* ---------- Platform icon ---------- */
export function PlatformIcon({
  id,
  size = "md",
  className,
}: {
  id: PlatformId;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const p = platforms[id];
  const s = { sm: "size-5 text-[9px]", md: "size-7 text-[11px]", lg: "size-10 text-sm" }[size];
  return (
    <span
      title={p.name}
      className={cn(
        "grid shrink-0 place-items-center rounded-md font-display font-bold text-white",
        s,
        className,
      )}
      style={{ background: p.color }}
    >
      {p.short}
    </span>
  );
}

/* ---------- Sentiment ---------- */
export function SentimentDot({ s, withLabel = false }: { s: Sentiment; withLabel?: boolean }) {
  const map = {
    positive: ["bg-positive", "Positive"],
    neutral: ["bg-neutral", "Neutral"],
    negative: ["bg-negative", "Negative"],
  }[s];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <span className={cn("size-2 rounded-full", map[0])} />
      {withLabel && map[1]}
    </span>
  );
}

export function SentimentBar({
  positive,
  neutral,
  negative,
  className,
}: {
  positive: number;
  neutral: number;
  negative: number;
  className?: string;
}) {
  return (
    <div className={cn("flex h-2.5 w-full overflow-hidden rounded-full bg-muted", className)}>
      <div className="bg-positive transition-all duration-700" style={{ width: `${positive}%` }} />
      <div className="bg-neutral transition-all duration-700" style={{ width: `${neutral}%` }} />
      <div className="bg-negative transition-all duration-700" style={{ width: `${negative}%` }} />
    </div>
  );
}

/* ---------- Status badge ---------- */
const statusStyles: Record<string, string> = {
  pending: "bg-warning-soft text-rating-foreground",
  replied: "bg-positive-soft text-positive",
  escalated: "bg-negative-soft text-negative",
  flagged: "bg-info-soft text-info",
  critical: "bg-negative text-destructive-foreground",
  high: "bg-negative-soft text-negative",
  medium: "bg-warning-soft text-rating-foreground",
  low: "bg-neutral-soft text-muted-foreground",
  info: "bg-info-soft text-info",
  active: "bg-positive-soft text-positive",
  invited: "bg-info-soft text-info",
  connected: "bg-positive-soft text-positive",
  disconnected: "bg-neutral-soft text-muted-foreground",
};

export function StatusBadge({
  status,
  className,
}: {
  status: ReviewStatus | string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold capitalize",
        statusStyles[status.toLowerCase()] ?? "bg-secondary text-secondary-foreground",
        className,
      )}
    >
      {status}
    </span>
  );
}

/* ---------- Section card ---------- */
export function Section({
  title,
  description,
  action,
  children,
  className,
  bodyClassName,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("card-elevated surface-sheen overflow-hidden", className)}>
      {title && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3 sm:px-5">
          <div className="min-w-0 flex-1">
            <h3 className="font-display text-sm font-bold text-foreground">{title}</h3>
            {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
          </div>
          {action}
        </header>
      )}
      <div className={cn("p-4 sm:p-5", bodyClassName)}>{children}</div>
    </section>
  );
}

/* ---------- Empty state ---------- */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-10 text-center">
      <span className="grid size-12 place-items-center rounded-2xl bg-accent text-primary">
        <Icon className="size-6" />
      </span>
      <h4 className="mt-4 font-display text-base font-bold">{title}</h4>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/* ---------- Interactive brand coin ---------- */
export function BrandMark({
  size = "md",
  light = false,
}: {
  size?: "sm" | "md" | "lg";
  light?: boolean;
}) {
  const spinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spinning = useRef(false);
  const sizeClass = { sm: "brand-coin-sm", md: "brand-coin-md", lg: "brand-coin-lg" }[size];

  useEffect(
    () => () => {
      if (spinTimer.current) clearTimeout(spinTimer.current);
    },
    [],
  );

  function spin(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    const button = event.currentTarget;
    const coin = button.querySelector<HTMLElement>(".brand-coin");
    // Re-entry is guarded with a ref rather than the disabled attribute.
    // Disabling a focused button blurs it, so a keyboard user would lose their
    // place after every press; and a React re-render during the spin would
    // reset an imperatively set attribute, letting a second click restart the
    // animation mid-flight. Neither happens with a ref.
    if (!coin || spinning.current) return;
    spinning.current = true;
    button.setAttribute("aria-busy", "true");
    coin.classList.add("brand-coin-spinning");
    spinTimer.current = setTimeout(() => {
      coin.classList.remove("brand-coin-spinning");
      button.setAttribute("aria-busy", "false");
      spinning.current = false;
      spinTimer.current = null;
    }, 840);
  }

  return (
    <Button
      type="button"
      variant="ghost"
      className={cn("brand-coin-button", sizeClass, light && "brand-coin-on-dark")}
      onClick={spin}
      aria-label={`Rotate ${BRAND.name} logo`}
      aria-busy="false"
      title={`Rotate ${BRAND.name} logo`}
    >
      <span className="brand-coin" aria-hidden="true">
        <span className="brand-coin-edge" />
        <img
          className="brand-coin-face brand-coin-front"
          src={darkCoinAsset}
          alt=""
          width={700}
          height={700}
          draggable={false}
        />
        <img
          className="brand-coin-face brand-coin-back"
          src={lightCoinAsset}
          alt=""
          width={700}
          height={700}
          draggable={false}
        />
      </span>
    </Button>
  );
}
