import { ChatView } from "@/components/ChatView";
import { currentSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const { user } = await currentSession();
  return <ChatView key={user.id} userId={user.id} />;
}
