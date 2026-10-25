import { getChatTurn } from "@/server/api/chat";
import { handle } from "@/server/api/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handle(req, (rt, user) => getChatTurn(rt, user, id));
}
