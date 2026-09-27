import { api } from 'sdk';
import { debugChatId, ownerTGID } from 'lib/config/config';
import { echo } from 'lib/debug';
import { getSettings } from 'lib/settings';

export const REPORT_TEXT = 'گزارش';
export const ADMIN_TEXT = 'ادمین';

const ROUTES = {
    [REPORT_TEXT]: {
        header: '🚩 گزارش جدید',
        target: () => debugChatId || ownerTGID,
    },
    [ADMIN_TEXT]: {
        header: '📩 پیام برای ادمین',
        target: () => ownerTGID || debugChatId,
    },
};

export function relayKind(message) {
    if (!message?.reply_to_message) {
        return null;
    }

    const text = (message.text ?? '').trim();

    return ROUTES[text] ? text : null;
}

export async function handleRelay(message, kind) {
    const route = ROUTES[kind];
    const chat = message.chat;
    const replied = message.reply_to_message;

    await echo(chat?.id, 'relay: received', {
        chat_id: chat?.id,
        kind,
        from_id: message.from?.id,
        replied_id: replied?.message_id,
    });

    const s = await getSettings();

    if (s?.group_chat_id && chat?.id !== s.group_chat_id) {
        await echo(chat?.id, 'relay: skip (not the registered group)');

        return;
    }

    const target = route.target();

    if (!target) {
        await echo(chat?.id, 'relay: skip (no target chat configured)');

        return;
    }

    const link = messageLink(replied);
    const content = (replied?.text ?? replied?.caption ?? '').trim();
    const lines = [
        route.header,
        `لینک: ${link ?? 'نامشخص'}`,
        `فرستنده: ${formatUser(message.from)}`,
        `گروه: ${chat?.title ?? chat?.id ?? 'نامشخص'}`,
    ];

    if (content) {
        lines.push(`متن پیام:\n${content.slice(0, 300)}`);
    }

    await echo(chat?.id, 'relay: forwarding', { kind, target, link });

    try {
        await api.sendMessage({
            chat_id: target,
            text: lines.join('\n'),
        });
    } catch (e) {
        await echo(chat?.id, 'relay: send failed', {
            code: e?.code,
            description: e?.description,
            message: e?.message,
        });

        throw e;
    }

    await deleteReporterMessage(message);
}

async function deleteReporterMessage(message) {
    const chat = message?.chat;

    if (!chat?.id || !message?.message_id) {
        return;
    }

    try {
        await api.deleteMessage({
            chat_id: chat.id,
            message_id: message.message_id,
        });

        await echo(chat.id, 'relay: reporter message deleted', {
            message_id: message.message_id,
        });
    } catch (e) {
        await echo(chat.id, 'relay: delete reporter message failed', {
            code: e?.code,
            description: e?.description,
            message: e?.message,
        });
    }
}

export function messageLink(message) {
    const chat = message?.chat;
    const messageId = message?.message_id;

    if (!chat || messageId === undefined || messageId === null) {
        return null;
    }

    if (chat.username) {
        return `https://t.me/${chat.username}/${messageId}`;
    }

    const id = String(chat.id);

    if (id.startsWith('-100')) {
        return `https://t.me/c/${id.slice(4)}/${messageId}`;
    }

    return null;
}

function formatUser(user) {
    if (!user) {
        return 'نامشخص';
    }

    const name = [user.first_name, user.last_name]
        .filter(Boolean)
        .join(' ');
    const handle = user.username ? `@${user.username}` : null;

    return [name, handle, user.id].filter(Boolean).join(' ');
}
