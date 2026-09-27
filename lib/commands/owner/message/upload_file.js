import { api, db } from 'sdk';
import {file_links, files, sessions} from 'schema';
import { eq } from 'sdk/db';

import { SessionType } from 'lib/domain/enums';
import { ownerID } from 'lib/config/config';
import { getUserByTelegramId } from 'lib/util/user';

const UploadFileState = Object.freeze({
    NotStarted: 0,
    WaitingForPost: 1,
    Done: 2,
});

export async function uploadCommand(
    message,
    user,
    session,
    ctx,
    command,
    args,
) {
    return

    if (message.from.id !== ownerID) {
        return;
    }

    /*
     * Starting a new upload.
     */
    if (command === "/uploadFile") {
        if (session.type !== SessionType.Start) {
            await api.sendMessage({
                chat_id: message.chat.id,
                text: "You already have an active session.",
            });

            return;
        }

        return await uploadFileCommandStart(
            message,
            user,
            session,
            ctx,
        );
    }

    /*
     * The rest requires an UploadFile session.
     */
    if (session.type !== SessionType.UploadFile) {
        return;
    }

    if (command === "/done") {
        return await uploadFileCommandDone(
            message,
            user,
            session,
            ctx,
        );
    }

    return await uploadFileCommandUploading(
        message,
        user,
        session,
        ctx,
    );
}

async function uploadFileCommandStart(
    message,
    user,
    session,
    ctx,
) {
    const expiresAt = new Date(
        Date.now() + 2 * 60 * 1000,
    );

    await db
        .update(sessions)
        .set({
            type: SessionType.UploadFile,
            state: UploadFileState.WaitingForPost,
            expires_at: expiresAt,
            updated_at: new Date(),
        })
        .where(eq(sessions.id, session.id))
        .run();

    await api.sendMessage({
        chat_id: message.chat.id,
        text: "Send the File Or Files",
    });
}

async function uploadFileCommandUploading(
    message,
    user,
    session,
    ctx,
) {
    if (session.state !== UploadFileState.WaitingForPost) {
        return;
    }

    /*
     * Check session expiration.
     */
    if (session.expires_at <= new Date()) {
        await expireUploadSession(session);

        await api.sendMessage({
            chat_id: message.chat.id,
            text: "Upload session expired.",
        });

        return;
    }

    const file = extractTelegramFile(message);

    if (!file) {
        await api.sendMessage({
            chat_id: message.chat.id,
            text: "Please send a file.",
        });

        return;
    }

    await saveFile(user, session, file);

    /*
     * Extend the session timeout after every successful upload.
     */
    const expiresAt = new Date(
        Date.now() + 2 * 60 * 1000,
    );

    await db
        .update(sessions)
        .set({
            expires_at: expiresAt,
            updated_at: new Date(),
        })
        .where(eq(sessions.id, session.id))
        .run();

    await api.sendMessage({
        chat_id: message.chat.id,
        text: "File received. Send another file or /done.",
    });
}

async function uploadFileCommandDone(
    message,
    user,
    session,
    ctx,
) {
    if (session.state !== UploadFileState.WaitingForPost) {
        return;
    }

    const uploadedFiles = await db
        .select()
        .from(files)
        .where(eq(files.session_id, session.id))
        .all();

    if (!uploadedFiles.length) {
        await api.sendMessage({
            chat_id: message.chat.id,
            text: "No files were uploaded.",
        });

        return;
    }

    /*
     * One token represents the entire upload batch.
     */
    const token = crypto.randomUUID();

    const expiresAt = new Date(
        Date.now() + FILE_LINK_EXPIRATION_MS,
    );

    /*
     * Create the share link.
     */
    const link = await db
        .insert(file_links)
        .values({
            token,
            created_by: user.id,
            expires_at: expiresAt,
        })
        .returning()
        .get();

    /*
     * Associate every uploaded file with that link.
     */
    for (const file of uploadedFiles) {
        await db
            .insert(file_link_items)
            .values({
                link_id: link.id,
                file_id: file.id,
            })
            .run();
    }

    /*
     * Reset the session.
     */
    await db
        .update(sessions)
        .set({
            type: SessionType.Start,
            state: UploadFileState.Done,
            expires_at: new Date(),
            updated_at: new Date(),
        })
        .where(eq(sessions.id, session.id))
        .run();

    /*
     * Telegram bot deep-link.
     *
     * Replace this with your actual bot username/config.
     */
    const shareLink =
        `https://t.me/YOUR_BOT_USERNAME?start=file_${token}`;

    await api.sendMessage({
        chat_id: message.chat.id,
        text:
            `Upload completed.\n\n` +
            `Files: ${uploadedFiles.length}\n` +
            `Expires: ${expiresAt.toISOString()}\n\n` +
            `Share this link:\n${shareLink}`,
    });
}

function extractTelegramFile(message) {
    if (message.document) {
        return {
            file_id: message.document.file_id,
            file_type: "document",
            name: message.document.file_name ?? null,
            caption: message.caption ?? null,
        };
    }

    if (message.photo?.length) {
        const photo = message.photo.at(-1);

        return {
            file_id: photo.file_id,
            file_type: "photo",
            name: null,
            caption: message.caption ?? null,
        };
    }

    if (message.video) {
        return {
            file_id: message.video.file_id,
            file_type: "video",
            name: message.video.file_name ?? null,
            caption: message.caption ?? null,
        };
    }

    if (message.audio) {
        return {
            file_id: message.audio.file_id,
            file_type: "audio",
            name: message.audio.file_name ?? null,
            caption: message.caption ?? null,
        };
    }

    return null;
}

async function saveFile(user, session, file) {
    await db
        .insert(files)
        .values({
            file_id: file.file_id,
            file_type: file.file_type,
            session_id: session.id,
            name: file.name,
            caption: file.caption,
            uploaded_by: user.id,
        })
        .run();
}

// export async function getFileCommand(message, ctx, args) {
//     // can be accessed by everyone to get the file using that link
// }

export async function getFileCommand(message, ctx, token) {
    const link = await db
        .select()
        .from(file_links)
        .where(eq(file_links.token, token))
        .get();

    if (!link) {
        await api.sendMessage({
            chat_id: message.chat.id,
            text: "This file link is invalid.",
        });

        return;
    }

    if (link.expires_at <= new Date()) {
        await api.sendMessage({
            chat_id: message.chat.id,
            text: "This file link has expired.",
        });

        return;
    }

    const items = await db
        .select()
        .from(file_link_items)
        .where(eq(file_link_items.link_id, link.id))
        .all();

    if (!items.length) {
        await api.sendMessage({
            chat_id: message.chat.id,
            text: "No files are associated with this link.",
        });

        return;
    }

    for (const item of items) {
        const file = await db
            .select()
            .from(files)
            .where(eq(files.id, item.file_id))
            .get();

        if (!file) {
            continue;
        }

        await sendTelegramFile(message.chat.id, file);
    }
}


async function sendTelegramFile(chatId, file) {
    switch (file.file_type) {
        case "document":
            await api.sendDocument({
                chat_id: chatId,
                document: file.file_id,
                caption: file.caption ?? undefined,
            });
            break;

        case "photo":
            await api.sendPhoto({
                chat_id: chatId,
                photo: file.file_id,
                caption: file.caption ?? undefined,
            });
            break;

        case "video":
            await api.sendVideo({
                chat_id: chatId,
                video: file.file_id,
                caption: file.caption ?? undefined,
            });
            break;

        case "audio":
            await api.sendAudio({
                chat_id: chatId,
                audio: file.file_id,
                caption: file.caption ?? undefined,
            });
            break;
    }
}

async function expireUploadSession(session) {
    await db
        .update(sessions)
        .set({
            type: SessionType.Start,
            state: UploadFileState.NotStarted,
            updated_at: new Date(),
            expires_at: new Date(),
        })
        .where(eq(sessions.id, session.id))
        .run();
}