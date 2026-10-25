import { DICTS, type Lang } from "./index";

/**
 * Localized text for a policy rule id or built-in reason code (e.g. "refund-large", "UNTRUSTED_SOURCE").
 * English keeps the policy file's own wording when it has one, because operators can edit it.
 * Other languages use the translated string for the code, and fall back to the original text.
 */
export function reasonText(lang: Lang, ruleId: string | null | undefined, fallback: string | null | undefined): string | null {
  const key = ruleId ? `reason.${ruleId}` : null;
  const dict = DICTS[lang] as Record<string, string>;
  if (lang === "en") return fallback ?? (key ? dict[key] ?? null : null);
  return (key && dict[key]) || fallback || null;
}

/** Localized text for an API error code, or null when the code has no translation. */
export function errorText(lang: Lang, code: string | null | undefined): string | null {
  return code ? (DICTS[lang] as Record<string, string>)[`errcode.${code}`] ?? null : null;
}
