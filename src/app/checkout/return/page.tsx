import { CheckoutResult, orderTokenFrom } from "@/components/CheckoutResult";
import { currentSession } from "@/server/session";

export const dynamic = "force-dynamic";

/** PayPal sends the buyer here after checkout (`?token=<order id>&PayerID=...`). Nothing is captured here. */
export default async function CheckoutReturnPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ lang }, params] = await Promise.all([currentSession(), searchParams]);
  return <CheckoutResult kind="return" token={orderTokenFrom(params.token)} lang={lang} />;
}
