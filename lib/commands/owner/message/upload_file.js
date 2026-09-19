import { api, db } from 'sdk';
import { sessions } from 'schema';
import { eq } from 'sdk/db';

import { SessionType } from 'lib/domain/enums';
import { ownerID } from 'lib/config/config';
import { getUserByTelegramId } from 'lib/util/user';

const uploadFileState = Object.freeze({
    NotStarted: 0,
    WaitingForPost: 1,
    Done: 2,
});

export async function uploadFileCommandStart(message, ctx, args) {
    const tgId = message.from.id;

    // Only owner can start an upload session.
    if (tgId !== ownerID) {
        return;
    }

    const user = await getUserByTelegramId(tgId);

    if (!user) {
        return;
    }

    const session = await db
        .select()
        .from(sessions)
        .where(eq(sessions.user_id, user.id))
        .get();

    if (!session) {
        return;
    }

    if (session.type !== SessionType.Start) {
        await api.sendMessage({
            chat_id: message.chat.id,
            text: 'You already have an active session.',
        });

        return;
    }

    const expiresAt = new Date(Date.now() + 2 * 60 * 1000);

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