import type { ReactNode } from "react";

/**
 * Chips are facts, badges are signals. Keeping them as two components rather
 * than one with a variant prop is deliberate — the distinction is the thing
 * people get wrong, and a shared component invites conflating them.
 */
export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-sm border border-border bg-sunken px-2 py-0.5 text-[0.6875rem] leading-4 text-muted">
      {children}
    </span>
  );
}

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "success" | "warning" | "danger";
  children: ReactNode;
}) {
  const tones = {
    neutral: "bg-sunken text-muted border-border",
    success: "bg-success-tint text-success border-success/30",
    warning: "bg-warning-tint text-warning border-warning/30",
    danger: "bg-danger-tint text-danger border-danger/30",
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-normal ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/** A labeled zone. Every one after the first draws its own top hairline. */
export function Zone({
  label,
  action,
  first,
  children,
}: {
  label: string;
  action?: ReactNode;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`p-5 ${first ? "" : "border-t border-border"}`}>
      <div className="mb-3 flex min-h-4 items-center justify-between gap-3">
        <span className="eyebrow">{label}</span>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-border bg-surface ${className}`}>{children}</div>
  );
}

type ButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "ghost";
  type?: "button" | "submit";
};

export function Button({
  children, onClick, disabled, variant = "secondary", type = "button",
}: ButtonProps) {
  const variants = {
    primary: "bg-primary text-on-primary hover:bg-primary-hover border-transparent",
    secondary: "bg-surface text-foreground hover:bg-sunken border-border",
    ghost: "bg-transparent text-muted hover:bg-sunken hover:text-foreground border-transparent",
  } as const;
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-8 items-center gap-1.5 rounded-sm border px-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]}`}
    >
      {children}
    </button>
  );
}

/** A stat with a fixed-height meta line, so toggling state never shifts layout. */
export function Stat({ value, label, meta }: { value: string; label: string; meta?: string }) {
  return (
    <div>
      <div className="tnum text-2xl leading-none font-bold text-foreground">{value}</div>
      <div className="mt-1.5 text-[0.6875rem] text-muted">{label}</div>
      <div className="h-4 text-[0.6875rem] text-faint">{meta ?? ""}</div>
    </div>
  );
}

export function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="px-5 py-16 text-center">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-[0.8125rem] text-muted">{detail}</p>
    </div>
  );
}
