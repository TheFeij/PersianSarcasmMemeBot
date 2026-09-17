import {getUsers, startCommand} from "lib/commands/message/start";
import { api } from 'sdk';

export default async function (message, ctx) {
    const text = message.text ?? "";

    const [command, ...args] = text.trim().split(/\s+/);

    switch (command) {
        case "/start":
            return await startCommand(message, ctx, args);

        case "/getUsers":
            return await getUsers(message, ctx, args);

        default:
            return await unknownCommand(message, ctx);
    }
}

async function unknownCommand(message, ctx) {
    await api.sendMessage({
        chat_id: message.chat.id,
        text: "Unknown command.",
    });
}