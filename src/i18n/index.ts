import ar from "./ar.json";
import en from "./en.json";

/** UI strings only. Arabic lives in ar.json; code and docs stay English. */

export type Lang = "en" | "ar";
export type Dict = typeof en;
export type MsgKey = keyof Dict;

export const DICTS: Record<Lang, Dict> = { en, ar };

export function isLang(v: unknown): v is Lang {
  return v === "en" || v === "ar";
}

export const dirOf = (lang: Lang): "rtl" | "ltr" => (lang === "ar" ? "rtl" : "ltr");

export function translate(lang: Lang, key: string, vars: Record<string, string | number> = {}): string {
  const dict = DICTS[lang] as Record<string, string>;
  const raw = dict[key] ?? (DICTS.en as Record<string, string>)[key] ?? key;
  return raw.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}
