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
