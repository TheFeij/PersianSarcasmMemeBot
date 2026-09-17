import { api, db } from 'sdk';
import {users} from 'schema';

export async function startCommand(message, ctx, args) {
    await db.insert(users).values({
        tg_id: message.from.id,
        username: message.from.username,
        first_name: message.from.first_name,
        last_name: message.from.last_name,
    }).run()

    await api.sendMessage({
        chat_id: message.chat.id,
        text: JSON.stringify(message, null, 2),
    });
}

export async function getUsers(message, ctx, args) {
    const rows = await db.select().from(users).all()

    await api.sendMessage({
        chat_id: message.chat.id,
        text: JSON.stringify(rows, null, 2),
    })
}