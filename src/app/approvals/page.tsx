import { ApprovalsView } from "@/components/ApprovalsView";
import { currentSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const { user } = await currentSession();
  return <ApprovalsView user={user} />;
}
