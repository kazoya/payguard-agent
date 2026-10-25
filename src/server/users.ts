import type { Role } from "@/guard/policy";

/**
 * Demo identities. PayGuard has no real login in the hackathon build: the role switcher sets a
 * cookie that picks one of these users. Authorization is still enforced server-side per user.
 */

export type DemoUser = { id: string; name: string; role: Role };

export const DEMO_USERS: readonly DemoUser[] = [
  { id: "u_clerk", name: "Lina", role: "clerk" },
  { id: "u_manager", name: "Omar", role: "approver" },
  { id: "u_owner", name: "Nour", role: "owner" },
];

export const USER_COOKIE = "pg_user";
export const LANG_COOKIE = "pg_lang";

export function userById(id: string | undefined | null): DemoUser | undefined {
  return DEMO_USERS.find((u) => u.id === id);
}

export function defaultUser(role: Role = "clerk"): DemoUser {
  return DEMO_USERS.find((u) => u.role === role) ?? DEMO_USERS[0]!;
}

/** Parses a raw Cookie header without trusting anything beyond the two known cookie names. */
export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function actorFromCookieHeader(header: string | null, fallbackRole: Role = "clerk"): DemoUser {
  return userById(readCookie(header, USER_COOKIE)) ?? defaultUser(fallbackRole);
}
