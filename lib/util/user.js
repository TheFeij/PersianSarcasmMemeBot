import { db } from 'sdk';
import { users } from 'schema';
import { eq } from 'sdk/db';

export async function getUserByTelegramId(tgId) {
    return await db
        .select()
        .from(users)
        .where(eq(users.tg_id, tgId))
        .get();
}