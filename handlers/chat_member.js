import { echo } from 'lib/debug';
import { handleChatMember } from 'lib/members';

export default async function (update, ctx) {
    try {
        await handleChatMember(update);
    } catch (e) {
        await echo(
            update?.chat?.id,
            'handler/chat_member: CRASH',
            e?.stack ?? String(e),
        );

        throw e;
    }
}
