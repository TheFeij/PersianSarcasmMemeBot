import { api } from 'sdk';
import { echo } from 'lib/debug';
import { getChannelByChatId, getChannelByGroupId } from 'lib/channels';

const TELEGRAM_CHANNEL_POST_FROM_ID = 777000;

export async function handleChannelPost(message) {
    const chatId = message.chat.id;

    await echo(chatId, 'guard: start', {
        chat_id: chatId,
        message_id: message.message_id,
    });

    // Auto-forwarded channel posts carry the source channel in sender_chat.
    // Fall back to the group -> channel mapping when it is missing.
    const senderChatId =
        message?.sender_chat?.type === 'channel'
            ? message.sender_chat.id
            : null;

    const senderChannel = senderChatId
        ? await getChannelByChatId(senderChatId)
        : null;

    const channel = senderChannel ?? (await getChannelByGroupId(chatId));

    await echo(chatId, 'guard: channel', channel);

    if (!channel?.phrase) {
        await echo(chatId, 'guard: skip (no channel or phrase)');

        return;
    }

    if (channel.group_chat_id && channel.group_chat_id !== chatId) {
        await echo(chatId, 'guard: skip (chat is not the channel group)', {
            got: chatId,
            expected: channel.group_chat_id,
        });

        return;
    }

    if (!channel.group_chat_id && senderChatId == null) {
        await echo(chatId, 'guard: skip (group is not registered)');

        return;
    }

    const content = message.text ?? message.caption ?? '';

    await echo(chatId, 'guard: content check', {
        has_phrase: content.includes(channel.phrase),
        content,
        phrase: channel.phrase,
    });

    if (content.includes(channel.phrase)) {
        return;
    }

    try {
        await api.deleteMessage({
            chat_id: message.chat.id,
            message_id: message.message_id,
        });

        await echo(chatId, 'guard: deleted', message.message_id);
    } catch (e) {
        await echo(chatId, 'guard: delete failed', {
            code: e?.code,
            description: e?.description,
            message: e?.message,
        });

        if (e.code !== 400) {
            throw e;
        }
    }
}

export { TELEGRAM_CHANNEL_POST_FROM_ID };
