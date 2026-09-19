import {api} from 'sdk';

export async function getMyID(message, ctx, args) {
    await api.sendMessage({
        chat_id: message.chat.id,
        text: `Your Telegram ID: ${message.from.id}`
    })
}