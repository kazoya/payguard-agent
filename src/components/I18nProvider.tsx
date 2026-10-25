"use client";

import { createContext, useContext, useMemo } from "react";
import { translate, type Lang } from "@/i18n";

type Ctx = { lang: Lang; t: (key: string, vars?: Record<string, string | number>) => string };

const I18nContext = createContext<Ctx>({ lang: "en", t: (k, v) => translate("en", k, v) });

export function I18nProvider({ lang, children }: { lang: Lang; children: React.ReactNode }) {
  const value = useMemo<Ctx>(() => ({ lang, t: (k, v) => translate(lang, k, v) }), [lang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): Ctx {
  return useContext(I18nContext);
}
