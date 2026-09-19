import { table, integer, text, sql } from 'sdk/db';

export const users = table("users", {
    id: integer('id').primaryKey({autoIncrement: true}),

    tg_id: integer('tg_id').notNull(),
    username: text('username'),
    first_name: text('first_name'),
    last_name: text('last_name'),

    created_at: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
    updated_at: integer('updated_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

export const channels = table("channels", {
    id: integer('id').primaryKey({autoIncrement: true}),

    tg_id: integer('tg_id').notNull(),
    username: text('username'),
});

export const channel_members = table("channel_members", {
    id: integer('id').primaryKey({ autoIncrement: true }),

    user_id: integer('user_id').notNull(),
    channel_id: integer('channel_id').notNull(),

    state: integer('state').notNull(),
    joined_via: integer('joined_via').notNull(),
    invite_link_name: text('invite_link_name'),

    joined_at: integer('joined_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
    left_at: integer('left_at', { mode: 'timestamp' }).default(sql`(unixepoch())`)
});

export const sessions = table("sessions", {
    id: integer('id').primaryKey({autoIncrement: true}),

    user_id: integer('user_id').notNull(),
    chat_id: integer('chat_id').notNull(),

    type: integer('type').notNull(),
    state: integer('state').notNull(),
    data: text('data'),

    created_at: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
    updated_at: integer('updated_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
    expires_at: integer('expires_at', { mode: 'timestamp' }).notNull(),
});

export const files = table("files", {
    id: integer('id').primaryKey({ autoIncrement: true }),

    file_id: text('file_id').notNull(),
    file_type: text('file_type').notNull(),

    name: text('name'),
    caption: text('caption'),

    uploaded_by: integer('uploaded_by').notNull(),

    created_at: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

export const file_links = table("file_links", {
    id: integer('id').primaryKey({ autoIncrement: true }),

    file_id: integer('file_id').notNull(),
    token: text('token').notNull(),

    created_by: integer('created_by').notNull(),

    created_at: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
    expires_at: integer('expires_at', { mode: 'timestamp' }).notNull(),
});