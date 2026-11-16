import { api, db } from 'sdk';
import { channels, settings } from 'schema';
import { eq } from 'sdk/db';
import { echo } from 'lib/debug';

export const LEGACY_SETTINGS_ID = 1;

// The legacy single-channel settings are copied into `channels` once. The flag
// only skips repeated COUNT queries inside a warm isolate; the insert itself is
// guarded by "channels is empty", so it stays safe across cold starts.
let seedChecked = false;

export async function ensureSeeded() {
    if (seedChecked) {
        return;
    }

    seedChecked = true;

    const existing = await db.$count(channels);

    if (existing > 0) {
        return;
    }

    const legacy = await db
        .select()
        .from(settings)
        .where(eq(settings.id, LEGACY_SETTINGS_ID))
        .get();

    if (!legacy?.channel_chat_id) {
        return;
    }

    await db
        .insert(channels)
        .values({
            channel_chat_id: legacy.channel_chat_id,
            group_chat_id: legacy.group_chat_id ?? null,
            phrase: legacy.phrase ?? null,
            buttons_enabled: legacy.buttons_enabled === true,
            buttons: Array.isArray(legacy.buttons) ? legacy.buttons : null,
            active: true,
            created_at: legacy.updated_at ?? new Date(),
            updated_at: legacy.updated_at ?? new Date(),
        })
        .onConflictDoNothing({ target: channels.channel_chat_id })
        .run();

    await echo(legacy.channel_chat_id, 'channels: seeded from legacy settings', {
        channel_chat_id: legacy.channel_chat_id,
        group_chat_id: legacy.group_chat_id,
    });
}

export async function listChannels({ activeOnly = false } = {}) {
    await ensureSeeded();

    const rows = await db.select().from(channels).all();

    return (rows ?? [])
        .filter((c) => !activeOnly || c.active !== false)
        .sort((a, b) => a.id - b.id);
}

export async function getChannelByChatId(chatId) {
    if (chatId == null) {
        return null;
    }

    await ensureSeeded();

    return await db
        .select()
        .from(channels)
        .where(eq(channels.channel_chat_id, chatId))
        .get();
}

export async function getChannelByGroupId(groupChatId) {
    if (groupChatId == null) {
        return null;
    }

    await ensureSeeded();

    return await db
        .select()
        .from(channels)
        .where(eq(channels.group_chat_id, groupChatId))
        .get();
}

export async function registerChannel(chat) {
    if (!chat?.id) {
        return null;
    }

    const existing = await getChannelByChatId(chat.id);
    const now = new Date();

    if (existing) {
        const patch = {};

        if (chat.title != null && chat.title !== existing.title) {
            patch.title = chat.title;
        }

        if (chat.username != null && chat.username !== existing.username) {
            patch.username = chat.username;
        }

        if (existing.active === false) {
            patch.active = true;
        }

        if (Object.keys(patch).length) {
            await db
                .update(channels)
                .set({ ...patch, updated_at: now })
                .where(eq(channels.id, existing.id))
                .run();
        }

        return { ...existing, ...patch };
    }

    await db
        .insert(channels)
        .values({
            channel_chat_id: chat.id,
            title: chat.title ?? null,
            username: chat.username ?? null,
            active: true,
            created_at: now,
            updated_at: now,
        })
        .run();

    await echo(chat.id, 'channels: registered', {
        channel_chat_id: chat.id,
        title: chat.title,
        username: chat.username,
    });

    return await getChannelByChatId(chat.id);
}

export async function deactivateChannel(chatId) {
    const existing = await getChannelByChatId(chatId);

    if (!existing) {
        return null;
    }

    await db
        .update(channels)
        .set({ active: false, updated_at: new Date() })
        .where(eq(channels.id, existing.id))
        .run();

    await echo(chatId, 'channels: deactivated', chatId);

    return { ...existing, active: false };
}

export async function setGroupChatId(channelChatId, groupChatId) {
    return await patchChannel(channelChatId, { group_chat_id: groupChatId });
}

export async function setPhrase(channelChatId, phrase) {
    return await patchChannel(channelChatId, { phrase });
}

export async function setButtonsEnabled(channelChatId, enabled) {
    return await patchChannel(channelChatId, { buttons_enabled: enabled });
}

export async function setButtons(channelChatId, buttons) {
    return await patchChannel(channelChatId, { buttons });
}

export async function resetChannel(channelChatId) {
    return await patchChannel(channelChatId, {
        group_chat_id: null,
        phrase: null,
        buttons: null,
        buttons_enabled: false,
    });
}

async function patchChannel(channelChatId, values) {
    const existing = await getChannelByChatId(channelChatId);

    if (!existing) {
        return null;
    }

    await db
        .update(channels)
        .set({ ...values, updated_at: new Date() })
        .where(eq(channels.id, existing.id))
        .run();

    return { ...existing, ...values };
}

export function channelRef(channel) {
    if (!channel) {
        return 'unknown channel';
    }

    if (channel.username) {
        return `@${channel.username}`;
    }

    return String(channel.channel_chat_id);
}

export function channelTitle(channel) {
    if (!channel) {
        return 'unknown channel';
    }

    const title = channel.title ?? 'Channel';
    const ref = channel.username ? `@${channel.username}` : channel.channel_chat_id;

    return `${title} (${ref})`;
}

export function channelLabel(channel) {
    if (!channel) {
        return 'unknown channel';
    }

    return `${channelTitle(channel)} · ${channel.channel_chat_id}`;
}

// A channel reference is `@username` or a numeric chat id. Titles are not
// accepted: they contain spaces and can be duplicated.
export async function findChannel(ref) {
    const raw = String(ref ?? '').trim();

    if (!raw) {
        return null;
    }

    const all = await listChannels();

    if (/^-?\d+$/.test(raw)) {
        const id = Number(raw);

        return all.find((c) => c.channel_chat_id === id) ?? null;
    }

    const username = raw.replace(/^@/, '').toLowerCase();

    return (
        all.find(
            (c) => String(c.username ?? '').toLowerCase() === username,
        ) ?? null
    );
}

// Finds the channel a command refers to from the given message:
// - an explicit `@username` / chat id argument, when provided;
// - the channel linked to the discussion group the command was sent in;
// - the only channel, when exactly one is registered.
export async function resolveChannel(message, ref) {
    if (ref) {
        return await findChannel(ref);
    }

    const chat = message?.chat;

    if (chat?.id != null) {
        const byGroup = await getChannelByGroupId(chat.id);

        if (byGroup) {
            return byGroup;
        }

        if (chat.type === 'group' || chat.type === 'supergroup') {
            const linkedId = await linkedChannelId(chat.id);

            if (linkedId != null) {
                return await getChannelByChatId(linkedId);
            }
        }
    }

    const all = await listChannels({ activeOnly: true });

    if (all.length === 1) {
        return all[0];
    }

    return null;
}

export async function linkedChannelId(groupChatId) {
    try {
        const chat = await api.getChat({ chat_id: groupChatId });

        return chat?.linked_chat_id ?? null;
    } catch (e) {
        await echo(groupChatId, 'channels: getChat failed', {
            code: e?.code,
            description: e?.description,
        });

        return null;
    }
}

export async function handleMyChatMember(update) {
    const chat = update?.chat;
    const newMember = update?.new_chat_member;

    if (!chat?.id || !newMember?.user?.is_bot) {
        return;
    }

    if (chat.type !== 'channel') {
        return;
    }

    const status = newMember.status;

    if (status === 'administrator' || status === 'creator') {
        return await registerChannel(chat);
    }

    if (status === 'left' || status === 'kicked') {
        return await deactivateChannel(chat.id);
    }
}
