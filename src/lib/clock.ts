/** Injected clock so tests can control time (approval TTL, daily caps). */
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

/** Calendar day (YYYY-MM-DD) in the policy time zone; daily caps reset at local midnight. */
export function dayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
