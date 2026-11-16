import { echo } from 'lib/debug';
import { handleMyChatMember } from 'lib/channels';

export default async function (update, ctx) {
    try {
        await handleMyChatMember(update);
    } catch (e) {
        await echo(
            update?.chat?.id,
            'handler/my_chat_member: CRASH',
            e?.stack ?? String(e),
        );

        throw e;
    }
}
