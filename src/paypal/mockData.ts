import { minorToDecimalString } from "@/lib/money";

/**
 * Sandbox-shaped responses for the read-only tools in mock mode. Field names follow the
 * Transaction Search v1 and Customer Disputes v1 APIs so the demo looks like real sandbox data.
 * All values are fictional.
 */

export type MockCaptureState = { id: string; amountMinor: number; refundedMinor: number; createdAt: string };
export type MockRefundState = { id: string; captureId: string; amountMinor: number; createdAt: string };

const money = (minor: number) => ({ currency_code: "USD", value: `${minor < 0 ? "-" : ""}${minorToDecimalString(Math.abs(minor))}` });
const BUYERS = ["sb-buyer-rania@personal.example.com", "sb-buyer-karim@personal.example.com", "sb-buyer-maya@personal.example.com"];

/** Transaction Search v1 (`GET /v1/reporting/transactions`) shape, newest first. */
export function transactionSearch(captures: MockCaptureState[], refunds: MockRefundState[]) {
  const sales = captures.map((c, i) => ({
    transaction_info: {
      transaction_id: c.id,
      transaction_event_code: "T0006",
      transaction_initiation_date: c.createdAt,
      transaction_amount: money(c.amountMinor),
      transaction_status: "S",
    },
    payer_info: { email_address: BUYERS[i % BUYERS.length] },
  }));
  const back = refunds.map((r) => ({
    transaction_info: {
      transaction_id: r.id,
      paypal_reference_id: r.captureId,
      transaction_event_code: "T1107",
      transaction_initiation_date: r.createdAt,
      transaction_amount: money(-r.amountMinor),
      transaction_status: "S",
    },
  }));
  const transaction_details = [...sales, ...back].sort((a, b) =>
    b.transaction_info.transaction_initiation_date.localeCompare(a.transaction_info.transaction_initiation_date));
  return { transaction_details, total_items: transaction_details.length, page: 1, total_pages: 1 };
}

/** Customer Disputes v1 (`GET /v1/customer/disputes`) shape with one open dispute on the largest capture. */
export function disputeList(captures: MockCaptureState[], now: string) {
  const biggest = [...captures].sort((a, b) => b.amountMinor - a.amountMinor)[0];
  if (!biggest) return { items: [] };
  return {
    items: [{
      dispute_id: "PP-D-27803",
      create_time: now,
      update_time: now,
      disputed_transactions: [{ seller_transaction_id: biggest.id }],
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      status: "WAITING_FOR_SELLER_RESPONSE",
      dispute_amount: money(Math.min(biggest.amountMinor, 25000)),
      dispute_life_cycle_stage: "INQUIRY",
    }],
  };
}
