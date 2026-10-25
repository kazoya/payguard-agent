import { z } from "zod";
import type { ApprovalError, ApprovalRow } from "@/approvals/queue";
import { appendNotice } from "../chatService";
import type { Runtime } from "../runtime";
import { userById, type DemoUser } from "../users";
import { apiError, json, parseBody, type ApiResponse } from "./http";

const STATUS_BY_CODE: Record<ApprovalError["code"], number> = {
  NOT_FOUND: 404,
  FORBIDDEN_ROLE: 403,
  SELF_APPROVAL: 403,
  ALREADY_DECIDED: 409,
  EXPIRED: 409,
  REASON_REQUIRED: 400,
};

const ListQuery = z.enum(["PENDING", "APPROVED", "EXECUTED", "REJECTED", "FAILED", "EXPIRED"]).optional();
const ApproveBody = z.object({ note: z.string().trim().max(500).optional() });
const RejectBody = z.object({ reason: z.string().max(500) });

export type ApprovalView = Omit<ApprovalRow, "args_json" | "result_json"> & {
  args: unknown;
  result: unknown;
  requested_by_name: string;
  decided_by_name: string | null;
};

const nameOf = (id: string | null) => (id ? userById(id)?.name ?? id : null);

export function toView(r: ApprovalRow): ApprovalView {
  const { args_json, result_json, ...rest } = r;
  return {
    ...rest,
    args: JSON.parse(args_json) as unknown,
    result: result_json ? (JSON.parse(result_json) as unknown) : null,
    requested_by_name: nameOf(r.requested_by)!,
    decided_by_name: nameOf(r.decided_by),
  };
}

export function listApprovals(rt: Runtime, status: string | null): ApiResponse {
  const s = ListQuery.safeParse(status ?? undefined);
  if (!s.success) return apiError(400, "INVALID_INPUT", "Unknown status filter.");
  rt.approvals.expireStale();
  return json(200, { approvals: rt.approvals.list(s.data).map(toView) });
}

const errorResponse = (e: ApprovalError) => apiError(STATUS_BY_CODE[e.code], e.code, e.message);

function noticeFor(rt: Runtime, row: ApprovalRow, user: DemoUser, resultId: string | null, checkoutUrl: string | null = null): void {
  if (!row.conversation_id || (row.status !== "EXECUTED" && row.status !== "FAILED" && row.status !== "REJECTED")) return;
  appendNotice(rt.db, row.conversation_id, {
    approvalId: row.id, status: row.status, tool: row.tool, amountMinor: row.amount_minor, currency: row.currency,
    decidedBy: user.name, note: row.decision_note, resultId, ...(checkoutUrl ? { checkoutUrl } : {}),
  }, rt.clock);
}

export async function approveApproval(rt: Runtime, user: DemoUser, id: string, body: unknown): Promise<ApiResponse> {
  const parsed = parseBody(ApproveBody, body ?? {});
  if (!parsed.ok) return parsed.error;
  const r = await rt.approvals.approve(id, { id: user.id, role: user.role }, parsed.value.note);
  if (!r.ok) return errorResponse(r.error);
  const row = rt.approvals.get(id)!;
  const data = r.value.status === "EXECUTED" ? (r.value.result.data as { id?: unknown } | undefined) : undefined;
  const checkoutUrl = r.value.status === "EXECUTED" ? r.value.result.checkoutUrl ?? null : null;
  noticeFor(rt, row, user, typeof data?.id === "string" ? data.id : null, checkoutUrl);
  return json(200, { approval: toView(row) });
}

export function rejectApproval(rt: Runtime, user: DemoUser, id: string, body: unknown): ApiResponse {
  const parsed = parseBody(RejectBody, body);
  if (!parsed.ok) return parsed.error;
  const r = rt.approvals.reject(id, { id: user.id, role: user.role }, parsed.value.reason);
  if (!r.ok) return errorResponse(r.error);
  const row = rt.approvals.get(id)!;
  noticeFor(rt, row, user, null);
  return json(200, { approval: toView(row) });
}
