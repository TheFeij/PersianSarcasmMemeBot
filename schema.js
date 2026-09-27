import { table, integer, text, boolean, sql } from 'sdk/db';

export const settings = table("settings", {
    id: integer('id').primaryKey({ autoIncrement: true }),

    group_chat_id: integer('group_chat_id'),
    phrase: text('phrase'),
    debug: boolean('debug').default(false),

    updated_at: integer('updated_at', { mode: 'timestamp' })
        .default(sql`(unixepoch())`),
});