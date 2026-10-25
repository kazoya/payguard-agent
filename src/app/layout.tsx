import type { Metadata } from "next";
import { Header } from "@/components/Header";
import { I18nProvider } from "@/components/I18nProvider";
import { dirOf } from "@/i18n";
import { currentSession } from "@/server/session";
import "./globals.css";

export const metadata: Metadata = {
  title: "PayGuard Agent",
  description: "Policy-guarded AI finance-ops agent on the PayPal sandbox",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { user, lang, mock } = await currentSession();
  return (
    <html lang={lang} dir={dirOf(lang)}>
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        <I18nProvider lang={lang}>
          <Header user={user} mock={mock} />
          <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
        </I18nProvider>
      </body>
    </html>
  );
}
