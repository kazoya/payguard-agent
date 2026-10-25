import { cookies } from "next/headers";
import { isLang, type Lang } from "@/i18n";
import { defaultUser, LANG_COOKIE, USER_COOKIE, userById, type DemoUser } from "./users";

/** Server-component view of the demo session (role + language cookies). */
export async function currentSession(): Promise<{ user: DemoUser; lang: Lang; mock: boolean }> {
  const jar = await cookies();
  const role = process.env.DEMO_DEFAULT_ROLE;
  const fallback = defaultUser(role === "approver" || role === "owner" ? role : "clerk");
  const lang = jar.get(LANG_COOKIE)?.value;
  const mock = process.env.PAYGUARD_MOCK === "1" || process.env.PAYGUARD_MOCK === "true";
  return { user: userById(jar.get(USER_COOKIE)?.value) ?? fallback, lang: isLang(lang) ? lang : "en", mock };
}
