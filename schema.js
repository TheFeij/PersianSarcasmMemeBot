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
    // Channel posts whose text/caption contains this string are pinned.
    pin_pattern: text('pin_pattern'),

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

// Scheduled ads per channel. The ad content (preceding post and banner) is
// stored as references to the message(s) the owner sent to the bot: a single
// message is copied at posting time, an album is re-sent with sendMediaGroup,
// which preserves media, captions and formatting. `reply_text`, when set, is
// sent as a reply to the banner.
export const ads = table("ads", {
    id: integer('id').primaryKey({ autoIncrement: true }),

    channel_chat_id: integer('channel_chat_id').notNull(),
    ad_date: text('ad_date').notNull(), // Gregorian, YYYY-MM-DD

    preceding_chat_id: integer('preceding_chat_id'),
    preceding_message_id: integer('preceding_message_id'),
    // Albums: the ordered source messages. Falls back to the single
    // chat/message id columns above for ads created before this existed.
    preceding_items: json('preceding_items'),
    preceding_media_group_id: text('preceding_media_group_id'),

    banner_chat_id: integer('banner_chat_id'),
    banner_message_id: integer('banner_message_id'),
    banner_items: json('banner_items'),
    banner_media_group_id: text('banner_media_group_id'),

    pin_banner: boolean('pin_banner').default(false),
    reply_text: text('reply_text'),

    posted_at: integer('posted_at', { mode: 'timestamp' }),
    created_at: integer('created_at', { mode: 'timestamp' })
        .default(sql`(unixepoch())`),
    updated_at: integer('updated_at', { mode: 'timestamp' })
        .default(sql`(unixepoch())`),
}, (t) => ({
    dateIdx: index('idx_ads_date').on(t.ad_date),
    channelIdx: index('idx_ads_channel').on(t.channel_chat_id),
}));

// One in-progress /setadd (or ad edit) flow per user (owner or ad admin).
// `step` is the field the bot is waiting for; `editing_ad_id` is set when the
// flow edits an existing ad instead of creating a new one.
export const adDrafts = table("ad_drafts", {
    id: integer('id').primaryKey({ autoIncrement: true }),

    owner_tg_id: integer('owner_tg_id').notNull().unique(),
    step: text('step').notNull(),

    channel_chat_id: integer('channel_chat_id'),
    ad_date: text('ad_date'),

    preceding_chat_id: integer('preceding_chat_id'),
    preceding_message_id: integer('preceding_message_id'),
    preceding_items: json('preceding_items'),
    preceding_media_group_id: text('preceding_media_group_id'),

    banner_chat_id: integer('banner_chat_id'),
    banner_message_id: integer('banner_message_id'),
    banner_items: json('banner_items'),
    banner_media_group_id: text('banner_media_group_id'),

    // Legacy: albums used to wait for a Done press. Album members are now
    // staged row by row in `ad_draft_items` and the flow advances immediately,
    // so nothing reads or writes this any more.
    album_open: boolean('album_open').default(false),

    pin_banner: boolean('pin_banner').default(false),
    reply_text: text('reply_text'),

    editing_ad_id: integer('editing_ad_id'),
    updated_at: integer('updated_at', { mode: 'timestamp' })
        .default(sql`(unixepoch())`),
});

// Staging area for the content of an in-progress draft (or content edit).
// Album members arrive as separate updates and may be processed concurrently,
// so each is inserted as its own row instead of read-modify-writing an array.
export const adDraftItems = table("ad_draft_items", {
    id: integer('id').primaryKey({ autoIncrement: true }),

    owner_tg_id: integer('owner_tg_id').notNull(),
    field: text('field').notNull(), // preceding | banner
    chat_id: integer('chat_id').notNull(),
    message_id: integer('message_id').notNull(),
    item: json('item').notNull(),

    created_at: integer('created_at', { mode: 'timestamp' })
        .default(sql`(unixepoch())`),
}, (t) => ({
    unique: uniqueIndex('uidx_ad_draft_items').on(
        t.owner_tg_id,
        t.field,
        t.message_id,
    ),
    ownerIdx: index('idx_ad_draft_items_owner').on(t.owner_tg_id),
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
