"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import { DEMO_USERS, type DemoUser } from "@/server/users";
import { useI18n } from "./I18nProvider";

const NAV = [
  { href: "/", key: "nav.chat" },
  { href: "/approvals", key: "nav.approvals" },
  { href: "/audit", key: "nav.audit" },
];

async function setSession(body: Record<string, string>): Promise<void> {
  await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

export function Header({ user, mock }: { user: DemoUser; mock: boolean }) {
  const { lang, t } = useI18n();
  const path = usePathname();
  const router = useRouter();
  const [pending, start] = useTransition();
  const update = (body: Record<string, string>) => start(async () => { await setSession(body); router.refresh(); });

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 text-lg font-bold text-slate-900">
          <span aria-hidden className="grid h-8 w-8 place-items-center rounded-lg bg-sky-700 text-white">🛡</span>
          {t("appName")}
        </Link>
        <nav className="flex gap-1">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${path === n.href ? "bg-sky-100 text-sky-900" : "text-slate-600 hover:bg-slate-100"}`}>
              {t(n.key)}
            </Link>
          ))}
        </nav>
        <div className="ms-auto flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-600">
            {t("role.label")}
            <select data-testid="role-select" disabled={pending} value={user.id} onChange={(e) => update({ userId: e.target.value })}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900">
              {DEMO_USERS.map((u) => <option key={u.id} value={u.id}>{u.name} · {t(`role.${u.role}`)}</option>)}
            </select>
          </label>
          <button type="button" data-testid="lang-toggle" disabled={pending} onClick={() => update({ lang: lang === "ar" ? "en" : "ar" })}
            className="rounded-md border border-slate-300 px-3 py-1 text-sm font-medium hover:bg-slate-100">
            {t("lang.switch")}
          </button>
        </div>
      </div>
      <div className="mx-auto flex max-w-5xl flex-wrap gap-2 px-4 pb-2">
        <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">{t("sandboxBadge")}</span>
        {mock && <span className="rounded bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-900">{t("mockBadge")}</span>}
      </div>
    </header>
  );
}
