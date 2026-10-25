import { z } from "zod";
import { LANG_COOKIE, USER_COOKIE, userById, type DemoUser } from "../users";
import { apiError, parseBody, type ApiResponse } from "./http";

const SessionBody = z.object({ userId: z.string().max(50).optional(), lang: z.enum(["en", "ar"]).optional() });

const cookie = (name: string, value: string) => `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; Max-Age=31536000`;

/** Demo-only session: picks one of the fixed demo users and/or the UI language. */
export function postSession(current: DemoUser, body: unknown): ApiResponse & { cookies: string[] } {
  const parsed = parseBody(SessionBody, body);
  if (!parsed.ok) return { ...parsed.error, cookies: [] };
  const cookies: string[] = [];
  let user = current;
  if (parsed.value.userId !== undefined) {
    const next = userById(parsed.value.userId);
    if (!next) return { ...apiError(400, "UNKNOWN_USER", "Unknown demo user."), cookies: [] };
    user = next;
    cookies.push(cookie(USER_COOKIE, next.id));
  }
  if (parsed.value.lang) cookies.push(cookie(LANG_COOKIE, parsed.value.lang));
  return { status: 200, body: { user, lang: parsed.value.lang ?? null }, cookies };
}
