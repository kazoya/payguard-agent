import type { Lang } from "@/i18n";

/** Display-only formatting. Latin digits in both languages so ids and amounts read the same. */
export function formatMoney(minor: number | null, currency: string | null, lang: Lang): string | null {
  if (minor === null) return null;
  const locale = lang === "ar" ? "ar-u-nu-latn" : "en-US";
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: currency ?? "USD" }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency ?? ""}`.trim();
  }
}

export function formatTime(iso: string, lang: Lang): string {
  const locale = lang === "ar" ? "ar-u-nu-latn" : "en-GB";
  return new Intl.DateTimeFormat(locale, { timeZone: "Asia/Amman", dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
}
