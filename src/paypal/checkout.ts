/**
 * PayPal checkout helpers for the order flow: clerk creates an order -> the buyer approves it on the
 * PayPal sandbox checkout page -> the clerk asks the agent to capture it (pay_order).
 *
 * - The buyer approval link is taken ONLY from the PayPal response (rel "payer-action" or "approve")
 *   and only if it is https on the sandbox checkout host. The UI never renders a link from model text.
 * - return_url / cancel_url are set by PayGuard from APP_BASE_URL, never by the model. The toolkit
 *   (@paypal/agent-toolkit 1.11.0) accepts `returnUrl`/`cancelUrl` on create_order and sends them as
 *   payment_source.paypal.experience_context.{return_url,cancel_url}; without them it uses example.com.
 */

export const CHECKOUT_HOSTS: readonly string[] = ["www.sandbox.paypal.com", "sandbox.paypal.com"];
const APPROVAL_RELS = ["payer-action", "approve"] as const;
/** Order-creation args the model may never choose: where PayPal sends the buyer afterwards. */
export const GUARD_OWNED_ORDER_ARGS = ["returnUrl", "cancelUrl"] as const;

export type CheckoutUrls = { returnUrl: string; cancelUrl: string };

/** `${base}/checkout/return` and `/checkout/cancel`, or null when no usable http(s) base URL is configured. */
export function checkoutUrlsFrom(appBaseUrl: string | null | undefined): CheckoutUrls | null {
  if (!appBaseUrl || appBaseUrl.trim() === "") return null;
  let base: URL;
  try {
    base = new URL(appBaseUrl.trim());
  } catch {
    return null;
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") return null;
  const root = `${base.origin}${base.pathname.replace(/\/+$/, "")}`;
  return { returnUrl: `${root}/checkout/return`, cancelUrl: `${root}/checkout/cancel` };
}

/**
 * Removes model-supplied redirect URLs from create_order args and sets PayGuard's own when configured.
 * Returns the args to execute plus the names of any model-supplied keys that were dropped.
 */
export function applyCheckoutUrls(tool: string, args: Record<string, unknown>, urls: CheckoutUrls | null): { args: Record<string, unknown>; dropped: string[] } {
  if (tool !== "create_order") return { args, dropped: [] };
  const out: Record<string, unknown> = { ...args };
  const dropped: string[] = [];
  for (const k of GUARD_OWNED_ORDER_ARGS) {
    if (k in out) {
      dropped.push(k);
      delete out[k];
    }
  }
  if (urls) Object.assign(out, urls);
  return { args: out, dropped };
}

export type ApprovalLink =
  | { kind: "accepted"; url: string }
  | { kind: "rejected"; rel: string; reason: "NOT_HTTPS" | "HOST_NOT_ALLOWED" | "INVALID_URL"; host: string | null }
  | { kind: "none" };

/** Checks one candidate URL against the sandbox checkout allowlist. */
export function verifyCheckoutUrl(href: string): { ok: true; url: string } | { ok: false; reason: "NOT_HTTPS" | "HOST_NOT_ALLOWED" | "INVALID_URL"; host: string | null } {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return { ok: false, reason: "INVALID_URL", host: null };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "NOT_HTTPS", host: u.hostname || null };
  if (u.username || u.password || u.port || !CHECKOUT_HOSTS.includes(u.hostname)) return { ok: false, reason: "HOST_NOT_ALLOWED", host: u.hostname || null };
  return { ok: true, url: u.toString() };
}

/** Finds the buyer approval link in an order response (create_order / get_order). */
export function extractApprovalLink(data: unknown): ApprovalLink {
  if (!data || typeof data !== "object") return { kind: "none" };
  const links = (data as { links?: unknown }).links;
  if (!Array.isArray(links)) return { kind: "none" };
  for (const rel of APPROVAL_RELS) {
    const link = links.find((l): l is { rel: string; href: unknown } => !!l && typeof l === "object" && (l as { rel?: unknown }).rel === rel);
    if (!link) continue;
    if (typeof link.href !== "string") return { kind: "rejected", rel, reason: "INVALID_URL", host: null };
    const v = verifyCheckoutUrl(link.href);
    return v.ok ? { kind: "accepted", url: v.url } : { kind: "rejected", rel, reason: v.reason, host: v.host };
  }
  return { kind: "none" };
}

/** The buyer only needs the link while the order still waits for them. */
export const AWAITING_BUYER = new Set(["CREATED", "PAYER_ACTION_REQUIRED"]);

export type CaptureSummary = { orderId: string; orderStatus: string | null; captureId: string | null; captureStatus: string | null };

/** First capture of a pay_order response (PayPal returns the order with purchase_units[].payments.captures[]). */
export function summarizeCapture(data: unknown): CaptureSummary | null {
  if (!data || typeof data !== "object") return null;
  const o = data as { id?: unknown; status?: unknown; purchase_units?: unknown };
  if (typeof o.id !== "string") return null;
  let capture: { id?: unknown; status?: unknown } | undefined;
  if (Array.isArray(o.purchase_units)) {
    for (const u of o.purchase_units as { payments?: { captures?: unknown } }[]) {
      const caps = u?.payments?.captures;
      if (Array.isArray(caps) && caps.length > 0) {
        capture = caps[0] as { id?: unknown; status?: unknown };
        break;
      }
    }
  }
  return {
    orderId: o.id,
    orderStatus: typeof o.status === "string" ? o.status : null,
    captureId: typeof capture?.id === "string" ? capture.id : null,
    captureStatus: typeof capture?.status === "string" ? capture.status : null,
  };
}

/**
 * The toolkit wraps capture results as `{status:"success"|"error", response:<order>}` while every
 * other tool returns the PayPal body directly. Returns the PayPal body, or an error for "error".
 */
export function unwrapToolkitData(tool: string, data: unknown): { ok: true; data: unknown } | { ok: false; message: string } {
  if (tool !== "pay_order" || !data || typeof data !== "object") return { ok: true, data };
  const o = data as { status?: unknown; response?: unknown };
  if ((o.status === "success" || o.status === "error") && "response" in o) {
    if (o.status === "success") return { ok: true, data: o.response };
    const r = o.response as { message?: unknown; name?: unknown } | undefined;
    return { ok: false, message: String(r?.message ?? r?.name ?? "PayPal capture failed").slice(0, 300) };
  }
  return { ok: true, data };
}
