import { NativeInbox } from "@/components/records/NativeInbox";
import { getPageData, getPageScope } from "@/lib/data";
import { listConversations } from "@/lib/native/conversations";
import { InboxClient } from "./InboxClient";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const { native } = await getPageData();
  if (!native) return <InboxClient />;
  const scope = await getPageScope();
  const initial = await listConversations(scope, { limit: 50 });
  return <NativeInbox initial={initial} canWrite={scope.ctx.permissions.includes("conversations.write")} />;
}
