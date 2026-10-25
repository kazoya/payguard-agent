/**
 * Money is integer minor units (cents) everywhere inside PayGuard.
 * These helpers are the only place where decimal strings or JS numbers are converted,
 * so float rounding can never leak into a policy decision.
 */

const DECIMAL_RE = /^(\d{1,12})(?:\.(\d{1,2}))?$/;

/** Parses "50", "50.0" or "50.01" into cents. Rejects negatives, >2 decimals and exponent forms. */
export function parseMoneyToMinor(value: string): number | null {
  const trimmed = value.trim();
  const m = DECIMAL_RE.exec(trimmed);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? "").padEnd(2, "0"));
  return whole * 100 + frac;
}

/**
 * The toolkit's create_order schema uses JS numbers. Converting through the shortest
 * decimal representation keeps 0.1 + 0.2 style artifacts out (19.99 -> 1999).
 */
export function numberToMinor(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  return parseMoneyToMinor(String(value));
}

export function minorToDecimalString(minor: number): string {
  if (!Number.isInteger(minor) || minor < 0) throw new RangeError("minor units must be a non-negative integer");
  const whole = Math.floor(minor / 100);
  const frac = String(minor % 100).padStart(2, "0");
  return `${whole}.${frac}`;
}
