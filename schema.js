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
})

export const channel_members = table("channel_members", {
    id: integer('id').primaryKey({autoIncrement: true}),

    user_id: integer('user_id').notNull(),
    channel_id: integer('channel_id').notNull(),

    state: integer('state').notNull(),
    joined_via: integer('joined_via').notNull(),
    invite_link_name: text('invite_link_name'),

    joined_at: integer('joined_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
    left_at: integer('joined_at', { mode: 'timestamp' }).default(sql`(unixepoch())`)
})

// export const files = table("files", {
//     id: integer().primaryKey().autoIncrement(),
//
//     file_id: text().notNull(),
//     file_type: text().notNull(),
//
//     name: text(),
//     caption: text(),
//
//     uploaded_by: integer().notNull(),
//
//     created_at: integer().notNull(),
// });
//
// export const file_links = table("file_links", {
//     id: integer().primaryKey().autoIncrement(),
//
//     file_id: integer().notNull(),
//     token: text().notNull(),
//
//     created_by: integer().notNull(),
//
//     created_at: integer().notNull(),
//     expires_at: integer(),
// });
//
// export const sessions = table("sessions", {
//     id: integer().primaryKey().autoIncrement(),
//
//     user_id: integer().notNull(),
//     chat_id: integer().notNull(),
//
//     state: text().notNull(),
//     data: text(),
//
//     created_at: integer().notNull(),
//     updated_at: integer().notNull(),
//     expires_at: integer().notNull(),
// });