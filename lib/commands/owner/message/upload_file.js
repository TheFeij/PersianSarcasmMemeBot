import { api, db } from 'sdk';
import {sessions} from 'schema';
import {SessionType} from "lib/domain/enums";
import {ownerID} from "lib/config/config";
import {eq} from 'sdk/db';

const uploadFileState = Object.freeze({
    NotStarted: 0,
    WaitingForPost: 1,
    Done: 2,
})

export async function uploadFileCommandStart(message, ctx, args) {
    if (message.from.id !== ownerID) {
        return;
    }

    const session = await db
        .select()
        .from(sessions)
        .where(eq(sessions.user_id, message.from.id))
        .get();

    if (!session) {
        return;
    }

    if (session.type !== SessionType.Start) {
        return;
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + 2 * 60;

    await db
        .update(sessions)
        .set({
            type: SessionType.UploadFile,
            state: uploadFileState.WaitingForPost,
            expires_at: expiresAt,
            updated_at: new Date(),
        })
        .where(eq(sessions.id, session.id))
        .run();

    await api.sendMessage({
        chat_id: message.chat.id,
        text: 'Send the File Or Files',
    });
}

export async function uploadFileCommandGetFile(message, ctx, args) {
    // get post from user

    // show inline keyboard, do you want to add file or done? if done, give the link to access the file
}

export async function gtFileCommand(message, ctx, args) {
    // can be accessed by everyone to get the file using that link
}