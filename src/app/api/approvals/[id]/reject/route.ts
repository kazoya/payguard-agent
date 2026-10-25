import { rejectApproval } from "@/server/api/approvals";
import { readJson } from "@/server/api/http";
import { handle } from "@/server/api/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const [{ id }, body] = await Promise.all([ctx.params, readJson(req)]);
  return handle(req, (rt, user) => rejectApproval(rt, user, id, body));
}
