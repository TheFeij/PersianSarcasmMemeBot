import { api } from 'sdk';
import { debugChatId, ownerTGID } from 'lib/config/config';
import { isDebugEnabled } from 'lib/settings';

export async function echo(fallbackChatId, label, value) {
    const text =
        `[debug] ${label}` +
        (value === undefined ? '' : `\n${format(value)}`);

    console.log(text);

    let enabled = false;

    try {
        enabled = await isDebugEnabled();
    } catch (e) {
        console.error('[debug] flag read failed:', e?.message ?? e);
    }

    if (!enabled) {
        return;
    }

    const chatId = debugChatId || ownerTGID || fallbackChatId;

    if (!chatId) {
        return;
    }

    try {
        await api.sendMessage({ chat_id: chatId, text });
    } catch (e) {
        console.error('[debug] echo failed:', e?.description ?? e?.message ?? e);
    }
}

function format(value) {
    if (typeof value === 'string') {
        return value;
    }

    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}
