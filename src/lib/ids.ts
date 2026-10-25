import { randomUUID } from "node:crypto";

/** Prefixed UUIDs; also used as PayPal-Request-Id, which accepts up to 108 characters. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
