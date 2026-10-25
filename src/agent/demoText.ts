import agentAr from "@/i18n/agent.ar.json";
import agentEn from "@/i18n/agent.en.json";

export type Lang = "en" | "ar";
type Key = keyof typeof agentEn;

const TEXT: Record<Lang, Record<Key, string>> = { en: agentEn, ar: agentAr };

/** Fills a demo-agent reply template; the strings live in src/i18n/agent.*.json. */
export function say(lang: Lang, key: Key, vars: Record<string, string | number | undefined> = {}): string {
  return TEXT[lang][key].replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? "?"));
}
