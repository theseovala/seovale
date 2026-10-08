import { cva } from "class-variance-authority";

export const buttonVariants = cva(
  "press inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-gradient-brand bg-primary text-primary-foreground shadow-[inset_0_1px_0_oklch(1_0_0_/_0.22),0_1px_2px_oklch(0_0_0_/_0.18),0_6px_18px_-10px_color-mix(in_oklab,var(--primary)_55%,transparent)] hover:bg-primary/92 hover:shadow-[inset_0_1px_0_oklch(1_0_0_/_0.26),0_0_0_1px_color-mix(in_oklab,var(--primary-glow)_35%,transparent),0_0_14px_-4px_color-mix(in_oklab,var(--primary-glow)_50%,transparent),0_8px_22px_-10px_color-mix(in_oklab,var(--primary)_65%,transparent)]",
        destructive:
          "bg-destructive text-destructive-foreground shadow-[inset_0_1px_0_oklch(1_0_0_/_0.18),0_1px_2px_oklch(0_0_0_/_0.18)] hover:bg-destructive/92 hover:shadow-[inset_0_1px_0_oklch(1_0_0_/_0.22),0_0_12px_-4px_color-mix(in_oklab,var(--destructive)_45%,transparent)]",
        outline:
          "border border-input bg-card shadow-xs hover:bg-accent hover:text-accent-foreground hover:border-primary/35 hover:shadow-[0_0_0_1px_color-mix(in_oklab,var(--primary)_14%,transparent),0_4px_14px_-8px_color-mix(in_oklab,var(--primary)_35%,transparent)]",
        secondary: "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-3.5 py-2",
        sm: "h-8 rounded-lg px-3 text-xs",
        lg: "h-10 rounded-lg px-6",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);
