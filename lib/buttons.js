import { api } from 'sdk';
import { echo } from 'lib/debug';
import {
    clearButtonsPending,
    getSettings,
    setButtons,
    setButtonsEnabled,
    setButtonsPending,
    setChannelChatId,
} from 'lib/settings';

export const BUTTON_COLORS = ['danger', 'success', 'primary'];

const COLOR_ALIASES = {
    danger: 'danger',
    red: 'danger',
    success: 'success',
    green: 'success',
    primary: 'primary',
    blue: 'primary',
    default: null,
    none: null,
    '': null,
};

export const BUTTON_SYNTAX_HINT =
    'One button per line:\n' +
    'row | color | text | link\n' +
    'Example:\n' +
    '1 | success | Subscribe | https://t.me/PersianSarcasm\n' +
    '1 | danger | Contact | https://t.me/example\n' +
    '2 | primary | Website | https://example.com\n' +
    'Buttons with the same row number share a row. ' +
    'Colors: danger, success, primary, default.';

function normalizeColor(color) {
    const key = String(color ?? '').trim().toLowerCase();

    if (Object.prototype.hasOwnProperty.call(COLOR_ALIASES, key)) {
        return COLOR_ALIASES[key];
    }

    return BUTTON_COLORS.includes(key) ? key : null;
}

export function parseButtons(text) {
    const lines = String(text ?? '').split('\n');
    const items = [];

    for (const raw of lines) {
        const line = raw.trim();

        if (!line) {
            continue;
        }

        const parts = line.split('|').map((p) => p.trim());

        if (parts.length < 4) {
            throw new Error(
                `Bad line, expected "row | color | text | link":\n${line}`,
            );
        }

        const [rowRaw, colorRaw, textRaw, ...linkParts] = parts;

        const row = Number.parseInt(rowRaw, 10);

        if (!Number.isFinite(row) || row < 1) {
            throw new Error(`Bad row number: ${rowRaw}`);
        }

        const label = textRaw.trim();
        const url = linkParts.join('|').trim();

        if (!label) {
            throw new Error(`Missing button text: ${line}`);
        }

        if (!url) {
            throw new Error(`Missing button link: ${line}`);
        }

        items.push({ row, color: normalizeColor(colorRaw), text: label, url });
    }

    if (!items.length) {
        throw new Error('No buttons found.');
    }

    return items;
}

export function buildKeyboard(buttons) {
    const rows = new Map();

    for (const button of buttons) {
        if (!rows.has(button.row)) {
            rows.set(button.row, []);
        }

        const keyboardButton = { text: button.text, url: button.url };

        if (button.color) {
            keyboardButton.style = button.color;
        }

        rows.get(button.row).push(keyboardButton);
    }

    return {
        inline_keyboard: [...rows.keys()]
            .sort((a, b) => a - b)
            .map((row) => rows.get(row)),
    };
}

export function formatButtons(buttons) {
    return [...buttons]
        .sort((a, b) => a.row - b.row)
        .map((b) => `${b.row} | ${b.color ?? 'default'} | ${b.text} | ${b.url}`)
        .join('\n');
}

export function targetFromForward(message) {
    const origin = message?.forward_origin;

    if (
        origin?.type === 'channel' &&
        origin.chat?.id != null &&
        origin.message_id != null
    ) {
        return {
            chat_id: origin.chat.id,
            message_id: origin.message_id,
            title: origin.chat.title,
            username: origin.chat.username,
        };
    }

    if (
        message?.forward_from_chat?.id != null &&
        message?.forward_from_message_id != null
    ) {
        return {
            chat_id: message.forward_from_chat.id,
            message_id: message.forward_from_message_id,
            title: message.forward_from_chat.title,
            username: message.forward_from_chat.username,
        };
    }

    return null;
}

export function targetFromLink(text) {
    const raw = String(text ?? '').trim();
    const match = raw.match(/t\.me\/(c\/)?([A-Za-z0-9_]+)\/(\d+)/);

    if (!match) {
        return null;
    }

    const isPrivate = Boolean(match[1]);
    const slug = match[2];
    const messageId = Number(match[3]);

    if (!Number.isFinite(messageId)) {
        return null;
    }

    return {
        chat_id: isPrivate ? Number(`-100${slug}`) : `@${slug}`,
        message_id: messageId,
        title: isPrivate ? undefined : slug,
        username: isPrivate ? undefined : slug,
    };
}

export function formatTarget(target) {
    if (!target) {
        return 'unknown';
    }

    const where = target.title
        ? `${target.title} (${target.chat_id})`
        : `${target.chat_id}`;

    return `${where} · message ${target.message_id}`;
}

export async function applyButtons(chatId, messageId, buttons, label = 'post') {
    const reply_markup = buildKeyboard(buttons);

    await echo(chatId, `buttons: editing ${label}`, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup,
    });

    return await api.editMessageReplyMarkup({
        chat_id: chatId,
        message_id: messageId,
        reply_markup,
    });
}

export async function handleNewChannelPost(post) {
    const chatId = post?.chat?.id;

    if (chatId == null) {
        return;
    }

    const s = await getSettings();

    if (!s?.channel_chat_id) {
        await setChannelChatId(chatId);
        await echo(chatId, 'buttons: registered channel', chatId);
    }

    if (!s?.buttons_enabled) {
        return;
    }

    if (!Array.isArray(s.buttons) || !s.buttons.length) {
        return;
    }

    if (s.channel_chat_id && s.channel_chat_id !== chatId) {
        await echo(chatId, 'buttons: skip (not the registered channel)', {
            got: chatId,
            expected: s.channel_chat_id,
        });

        return;
    }

    await echo(chatId, 'buttons: auto-applying to new channel post', {
        message_id: post.message_id,
        buttons: s.buttons.length,
    });

    try {
        await applyButtons(chatId, post.message_id, s.buttons, 'channel post');
    } catch (e) {
        await echo(chatId, 'buttons: auto-apply failed', {
            code: e?.code,
            description: e?.description,
            message: e?.message,
        });
    }
}

export async function saveGlobalButtons(text) {
    const items = parseButtons(text);

    await setButtons(items);
    await clearButtonsPending();

    return items;
}

export async function setGlobalButtonsEnabled(enabled) {
    await setButtonsEnabled(enabled);

    return enabled;
}

export function startGlobalButtonsFlow() {
    return setButtonsPending({
        action: 'global',
        step: 'buttons',
        target: null,
    });
}

export function startPostFlow(target) {
    return setButtonsPending({
        action: 'post',
        step: target ? 'buttons' : 'target',
        target: target ?? null,
    });
}
