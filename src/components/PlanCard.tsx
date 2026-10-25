import type { DisplayCard } from "@/server/chatService";
import { formatMoney } from "@/lib/format";
import type { Lang } from "@/i18n";
import { reasonText } from "@/i18n/reasons";
import { StatusBadge } from "./StatusBadge";

type T = (key: string, vars?: Record<string, string | number>) => string;

const BORDER: Record<string, string> = {
  executed: "border-emerald-300",
  pending_approval: "border-amber-300",
  denied: "border-rose-300",
  failed: "border-rose-300",
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-sm">
      <dt className="w-24 shrink-0 text-slate-500">{label}</dt>
      <dd className="min-w-0 break-words font-medium text-slate-900">{children}</dd>
    </div>
  );
}

const Mono = ({ children }: { children: React.ReactNode }) => (
  <bdi dir="ltr" className="font-mono text-[0.8rem]">{children}</bdi>
);

/** The structured plan for one PayPal action and the guard's decision on it. */
export function PlanCard({ card, lang, t }: { card: DisplayCard; lang: Lang; t: T }) {
  const amount = formatMoney(card.amountMinor, card.currency, lang) ?? (card.tool === "create_refund" ? t("card.fullAmount") : null);
  const live = card.approvalStatus && card.approvalStatus !== "PENDING" ? card.approvalStatus : null;
  return (
    <article data-testid="plan-card" className={`mt-2 rounded-lg border-2 bg-white p-3 shadow-sm ${BORDER[card.status] ?? "border-slate-200"}`}>
      <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">{t("card.plan")}</h3>
        <div className="flex gap-1">
          <StatusBadge status={card.status} label={t(`status.${card.status}`)} />
          {live && <StatusBadge status={live} label={t(`approvals.status.${live}`)} />}
        </div>
      </header>
      {card.plan && <p className="mb-2 text-sm text-slate-700">{card.plan}</p>}
      <dl className="space-y-1">
        <Row label={t("card.action")}>{t(`tool.${card.tool}`)}</Row>
        {amount && <Row label={t("card.amount")}>{amount}</Row>}
        {card.target && <Row label={t("card.target")}><Mono>{card.target}</Mono></Row>}
        {card.ruleId && <Row label={t("card.rule")}><Mono>{card.ruleId}</Mono></Row>}
        {card.reason && <Row label={t("card.why")}>{reasonText(lang, card.ruleId, card.reason)}</Row>}
        {card.resultId && <Row label={t("card.result")}><Mono>{card.resultId}</Mono></Row>}
        {card.error && <Row label={t("card.result")}>{card.error}</Row>}
        {card.approvalId && (
          <Row label={t("card.approval")}>
            <a className="text-sky-700 underline" href="/approvals"><Mono>{card.approvalId.slice(0, 12)}…</Mono></a>
          </Row>
        )}
      </dl>
    </article>
  );
}
