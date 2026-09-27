import { ownerTGID } from 'lib/config/config';
import { echo } from 'lib/debug';
import { handleChannelPost } from 'lib/guard';
import { handleOwnerMessage } from 'lib/owner';
import { handleRelay, relayKind } from 'lib/relay';

const TELEGRAM_CHANNEL_POST_FROM_ID = 777000;

export default async function (message, ctx) {
    const chatId = message?.chat?.id;

    try {
        const isChannelPost =
            message?.from?.id === TELEGRAM_CHANNEL_POST_FROM_ID ||
            message?.is_automatic_forward === true;

        const text = message?.text ?? message?.caption ?? '';

        if (
            isChannelPost ||
            message?.from?.id === ownerTGID ||
            text.startsWith('/')
        ) {
            await echo(chatId, 'handler/message: received', {
                chat_id: chatId,
                chat_type: message?.chat?.type,
                from_id: message?.from?.id,
                from_is_bot: message?.from?.is_bot,
                is_automatic_forward: message?.is_automatic_forward,
                text,
                decision: isChannelPost ? 'channel post' : 'owner/other',
            });
        }

        if (isChannelPost) {
            return await handleChannelPost(message);
        }

        const kind = relayKind(message);

        if (kind) {
            return await handleRelay(message, kind);
        }

        return await handleOwnerMessage(message);
    } catch (e) {
        await echo(chatId, 'handler/message: CRASH', e?.stack ?? String(e));
        throw e;
    }
}
