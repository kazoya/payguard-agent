import path from "node:path";
import { openDb } from "@/db/db";
import { loadPolicyFile, type Policy } from "@/guard/policy";
import { MockPayPal } from "@/paypal/mockPayPal";
import { createPayGuard } from "@/server/container";

export const ROOT = path.resolve(__dirname, "../..");
export const DEFAULT_POLICY_PATH = path.join(ROOT, "policies/default.policy.yaml");
export const MIGRATIONS_DIR = path.join(ROOT, "src/db/migrations");

export function defaultPolicy(): Policy {
  return loadPolicyFile(DEFAULT_POLICY_PATH);
}

/** A controllable clock: tests move time explicitly. */
export function fakeClock(start = "2026-10-24T09:00:00.000Z") {
  let now = new Date(start).getTime();
  const clock = () => new Date(now);
  return { clock, advanceHours: (h: number) => { now += h * 3_600_000; }, set: (iso: string) => { now = new Date(iso).getTime(); } };
}

export function makeHarness(opts: { start?: string } = {}) {
  const db = openDb(":memory:", MIGRATIONS_DIR);
  const time = fakeClock(opts.start);
  const paypal = new MockPayPal();
  const pg = createPayGuard({ db, policy: defaultPolicy(), handlerFactory: paypal.factory, clock: time.clock });
  return { db, time, paypal, ...pg };
}

export const clerk = { id: "u_clerk", role: "clerk" as const };
export const approver = { id: "u_manager", role: "approver" as const };
export const owner = { id: "u_owner", role: "owner" as const };

export const refundArgs = (captureId: string, value?: string) => ({
  capture_id: captureId,
  ...(value !== undefined ? { amount: { currency_code: "USD", value } } : {}),
});
