import {
    table,
    integer,
    text,
    boolean,
    json,
    index,
    uniqueIndex,
    sql,
} from 'sdk/db';

// Global bot state. The channel/group/phrase/buttons columns are legacy
// single-channel settings: they are read once to seed `channels` (see
// lib/channels.js) and are otherwise unused.
export const settings = table("settings", {
    id: integer('id').primaryKey({ autoIncrement: true }),

    group_chat_id: integer('group_chat_id'),
    channel_chat_id: integer('channel_chat_id'),
    phrase: text('phrase'),
    debug: boolean('debug').default(false),

    buttons_enabled: boolean('buttons_enabled').default(false),
    buttons: json('buttons'),
    buttons_pending: json('buttons_pending'),

    updated_at: integer('updated_at', { mode: 'timestamp' })
        .default(sql`(unixepoch())`),
});

// One row per channel the bot manages. A channel may have a linked discussion
// group, its own phrase and its own default buttons.
export const channels = table("channels", {
    id: integer('id').primaryKey({ autoIncrement: true }),

    channel_chat_id: integer('channel_chat_id').notNull().unique(),
    title: text('title'),
    username: text('username'),

    group_chat_id: integer('group_chat_id'),
    phrase: text('phrase'),

    buttons_enabled: boolean('buttons_enabled').default(false),
    buttons: json('buttons'),

    active: boolean('active').default(true),

    created_at: integer('created_at', { mode: 'timestamp' })
        .default(sql`(unixepoch())`),
    updated_at: integer('updated_at', { mode: 'timestamp' })
        .default(sql`(unixepoch())`),
}, (t) => ({
    groupIdx: index('idx_channels_group').on(t.group_chat_id),
    usernameIdx: index('idx_channels_username').on(t.username),
}));

// Legacy single-channel membership table. It is kept as-is (its `tg_id` is
// unique, so it cannot hold the same user in several channels) and is copied
// once into `channel_members`; nothing writes to it any more.
export const members = table("members", {
    id: integer('id').primaryKey({ autoIncrement: true }),

    chat_id: integer('chat_id'),
    tg_id: integer('tg_id').unique(),
    status: text('status'),
    source: text('source'),
    invite_link: text('invite_link'),

    created_at: integer('created_at', { mode: 'timestamp' })
        .default(sql`(unixepoch())`),
    updated_at: integer('updated_at', { mode: 'timestamp' })
        .default(sql`(unixepoch())`),
}, (t) => ({
    updatedIdx: index('idx_members_updated').on(t.updated_at),
    statusIdx: index('idx_members_status').on(t.status),
}));

// Membership history per channel: the same Telegram user can be tracked in
// several channels, so the identity is (chat_id, tg_id).
export const channelMembers = table("channel_members", {
    id: integer('id').primaryKey({ autoIncrement: true }),

    chat_id: integer('chat_id'),
    tg_id: integer('tg_id'),
    status: text('status'),
    source: text('source'),
    invite_link: text('invite_link'),

    created_at: integer('created_at', { mode: 'timestamp' })
        .default(sql`(unixepoch())`),
    updated_at: integer('updated_at', { mode: 'timestamp' })
        .default(sql`(unixepoch())`),
}, (t) => ({
    updatedIdx: index('idx_channel_members_updated').on(t.updated_at),
    statusIdx: index('idx_channel_members_status').on(t.status),
    chatIdx: index('idx_channel_members_chat').on(t.chat_id),
    chatTgIdx: uniqueIndex('uidx_channel_members_chat_tg').on(t.chat_id, t.tg_id),
}));
