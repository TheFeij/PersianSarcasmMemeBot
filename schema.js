import { table, integer, text, sql } from 'sdk/db';

export const messages = table('messages', {
    id:      integer('id').primaryKey({ autoIncrement: true }),
    chatId:  integer('chat_id').notNull(),
    text:    text('text').notNull(),
    created: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});
