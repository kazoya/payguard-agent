import { translate, type Lang } from "@/i18n";

/** PayPal order ids are short upper-case alphanumerics; anything else in `token` is not echoed back. */
const ORDER_TOKEN = /^[A-Z0-9]{8,30}$/;

export function orderTokenFrom(raw: string | string[] | undefined): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v && ORDER_TOKEN.test(v) ? v : null;
}

/** Landing page after PayPal checkout (return_url / cancel_url set by PayGuard from APP_BASE_URL). */
export function CheckoutResult({ kind, token, lang }: { kind: "return" | "cancel"; token: string | null; lang: Lang }) {
  const t = (k: string, v?: Record<string, string | number>) => translate(lang, k, v);
  const body = token ? t(`checkout.${kind}Body`, { token }) : t(`checkout.${kind}NoToken`);
  const ok = kind === "return";
  return (
    <section data-testid={`checkout-${kind}`} className={`mx-auto max-w-xl rounded-xl border-2 bg-white p-6 shadow-sm ${ok ? "border-emerald-300" : "border-amber-300"}`}>
      <h1 className="mb-2 text-xl font-semibold">{t(`checkout.${kind}Title`)}</h1>
      <p className="mb-4 text-sm text-slate-700">{body}</p>
      {token && ok && (
        <p className="mb-4 rounded-md bg-slate-100 px-3 py-2 text-sm">
          <bdi dir="ltr" className="font-mono">capture order {token}</bdi>
        </p>
      )}
      <a href="/" className="inline-block rounded-lg bg-sky-700 px-4 py-2 text-sm font-semibold text-white">{t("checkout.backToChat")}</a>
    </section>
  );
}
