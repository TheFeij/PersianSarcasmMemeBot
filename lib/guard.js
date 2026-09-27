import { api } from 'sdk';
import { echo } from 'lib/debug';
import { getSettings } from 'lib/settings';

export async function handleChannelPost(message) {
    const chatId = message.chat.id;

    await echo(chatId, 'guard: start', {
        chat_id: chatId,
        message_id: message.message_id,
    });

    const s = await getSettings();

    await echo(chatId, 'guard: settings', s);

    if (!s?.group_chat_id || !s.phrase) {
        await echo(chatId, 'guard: skip (group or phrase not set)');

        return;
    }

    if (message.chat.id !== s.group_chat_id) {
        await echo(chatId, 'guard: skip (chat is not the registered group)', {
            got: message.chat.id,
            expected: s.group_chat_id,
        });

        return;
    }

    const content = message.text ?? message.caption ?? '';

    await echo(chatId, 'guard: content check', {
        has_phrase: content.includes(s.phrase),
        content,
        phrase: s.phrase,
    });

    if (content.includes(s.phrase)) {
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
