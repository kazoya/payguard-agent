import { listAudit } from "@/server/api/audit";
import { handle } from "@/server/api/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request) {
  return handle(req, (rt) => listAudit(rt, new URL(req.url).searchParams.get("limit")));
}
