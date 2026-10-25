import { verifyAudit } from "@/server/api/audit";
import { handle } from "@/server/api/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(req: Request) {
  return handle(req, (rt) => verifyAudit(rt));
}
