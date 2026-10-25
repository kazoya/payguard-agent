import { listApprovals } from "@/server/api/approvals";
import { handle } from "@/server/api/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request) {
  return handle(req, (rt) => listApprovals(rt, new URL(req.url).searchParams.get("status")));
}
