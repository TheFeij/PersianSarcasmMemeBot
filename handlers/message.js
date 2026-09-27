import {createUserAndSession, getUsers, startCommand} from "lib/commands/common/message/start";
import { getMyID } from "lib/setup/set_owner";
import { api, db } from "sdk";
import { customReplyKeyboard, setMenu } from "lib/setup/command_menu";
import { getUserByTelegramId } from "lib/util/user";
import { sessions } from "schema";
import { eq } from "sdk/db";
import { SessionType } from "lib/domain/enums";
import {uploadCommand} from "lib/commands/owner/message/upload_file";

export default async function (message, ctx) {
    const text = message.text ?? "";

    const [command, ...args] = text.trim().split(/\s+/);

    let user = await getUserByTelegramId(message.from.id);
    let session;

    if (!user) {
        ({ user, session } = await createUserAndSession(
            message,
            ctx,
            args,
        ));
    }

    if (!session) {
        session = await db
            .select()
            .from(sessions)
            .where(eq(sessions.user_id, user.id))
            .get();
    }

    if (!session) {
        return await startCommand(message, ctx, args);
    }

    /*
     * Session-driven messages come before command routing.
     *
     * This is what allows:
     *
     *   document
     *   photo
     *   video
     *
     * to reach the upload handler even though they
     * don't contain a command.
     */
    if (session.type === SessionType.UploadFile) {
        return await uploadCommand(
            message,
            user,
            session,
            ctx,
            command,
            args,
        );
    }

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

        case "/uploadFile":
            return await uploadCommand(
                message,
                user,
                session,
                ctx,
                command,
                args,
            );

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