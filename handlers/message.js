import { api, db } from 'sdk';
import { messages } from 'schema';
import { eq } from 'sdk/db'

export default async function (message, ctx) {
    const msgs = await db.select().from(messages).all()
    console.log(msgs)

    // Save this message.
    await db.insert(messages)
        .values({ chatId: message.chat.id, text: message.text })
        .run();

    // Count how many we've stored for this chat.
    const count = await db.$count(messages, eq(messages.chatId, message.chat.id));

    await api.sendMessage({
        chat_id: message.chat.id,
        text: `Saved. That's ${count} message(s) from this chat so far. ${message.chat.id}`,
    });
}
