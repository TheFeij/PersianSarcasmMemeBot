import {getUsers, startCommand} from "lib/commands/common/message/start";
import {getMyID} from "lib/setup/set_owner";
import { api } from 'sdk';
import {customReplyKeyboard, setMenu} from "lib/setup/command_menu";

export default async function (message, ctx) {
    const text = message.text ?? "";

    const [command, ...args] = text.trim().split(/\s+/);

    switch (command) {
        case "/start":
            return await startCommand(message, ctx, args);

        case "/getUsers":
            return await getUsers(message, ctx, args);

        case "/getMyID":
            return await getMyID(message, ctx, args);

        case "/setMenu":
            return await setMenu(message, ctx, args);

       case "/keyboard":
            return await customReplyKeyboard(message, ctx, args);

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