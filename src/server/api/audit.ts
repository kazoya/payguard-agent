import { z } from "zod";
import type { Runtime } from "../runtime";
import { apiError, json, type ApiResponse } from "./http";

const Limit = z.coerce.number().int().min(1).max(1000).default(200);
const Format = z.enum(["json", "csv"]);

/** Newest first, for the audit view. Read-only: nothing here can write the log. */
export function listAudit(rt: Runtime, limit: string | null): ApiResponse {
  const l = Limit.safeParse(limit ?? undefined);
  if (!l.success) return apiError(400, "INVALID_INPUT", "limit must be 1..1000");
  const all = rt.audit.all();
  return json(200, { total: all.length, rows: all.slice(-l.data).reverse() });
}

export function verifyAudit(rt: Runtime): ApiResponse {
  return json(200, rt.audit.verifyChain());
}

export function exportAudit(rt: Runtime, format: string | null): ApiResponse {
  const f = Format.safeParse(format ?? "json");
  if (!f.success) return apiError(400, "INVALID_INPUT", "format must be json or csv");
  const stamp = rt.clock().toISOString().slice(0, 10);
  return f.data === "csv"
    ? { status: 200, body: rt.audit.exportCsv(), headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="payguard-audit-${stamp}.csv"` } }
    : { status: 200, body: rt.audit.exportJson(), headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="payguard-audit-${stamp}.json"` } };
}
