import type { CardStatus } from "@/agent/planCard";

const STYLES: Record<string, string> = {
  executed: "bg-emerald-100 text-emerald-900 ring-emerald-300",
  EXECUTED: "bg-emerald-100 text-emerald-900 ring-emerald-300",
  pending_approval: "bg-amber-100 text-amber-900 ring-amber-300",
  PENDING: "bg-amber-100 text-amber-900 ring-amber-300",
  APPROVED: "bg-sky-100 text-sky-900 ring-sky-300",
  denied: "bg-rose-100 text-rose-900 ring-rose-300",
  REJECTED: "bg-rose-100 text-rose-900 ring-rose-300",
  failed: "bg-rose-100 text-rose-900 ring-rose-300",
  FAILED: "bg-rose-100 text-rose-900 ring-rose-300",
  EXPIRED: "bg-slate-200 text-slate-700 ring-slate-300",
};

const ICONS: Record<string, string> = { executed: "✓", EXECUTED: "✓", pending_approval: "⏳", PENDING: "⏳", denied: "⛔", REJECTED: "⛔", failed: "!", FAILED: "!" };

export function StatusBadge({ status, label }: { status: CardStatus | string; label: string }) {
  return (
    <span
      data-testid="status-badge"
      data-status={status}
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${STYLES[status] ?? "bg-slate-100 text-slate-800 ring-slate-300"}`}
    >
      <span aria-hidden>{ICONS[status] ?? "•"}</span>
      {label}
    </span>
  );
}
