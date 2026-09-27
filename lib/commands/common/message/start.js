import { api, db } from "sdk";
import { users, sessions } from "schema";
import { eq } from "sdk/db";
import { SessionType } from "lib/domain/enums";

const SessionState = Object.freeze({
    Active: 0,
});

export async function startCommand(message, ctx, args) {
    const tgId = message.from.id;

    let user = await db
        .select()
        .from(users)
        .where(eq(users.tg_id, tgId))
        .get();

    let firstInteraction = false

    if (!user) {
        firstInteraction = true

        user = await db
            .insert(users)
            .values({
                tg_id: tgId,
                username: message.from.username ?? null,
                first_name: message.from.first_name ?? null,
                last_name: message.from.last_name ?? null,
            })
            .returning()
            .get();
    }

    let session

    if (!firstInteraction) {
        session = await db
            .select()
            .from(sessions)
            .where(eq(sessions.user_id, user.id))
            .get();
    }

    if (!session) {
        session = await db
            .insert(sessions)
            .values({
                user_id: user.id,
                chat_id: message.chat.id,

                type: SessionType.Start,
                state: SessionState.Active,

                expires_at: new Date(
                    Date.now() + 24 * 60 * 60 * 1000
                ),
            })
            .returning()
            .get();
    }

    await api.sendMessage({
        chat_id: message.chat.id,
        text: JSON.stringify({
            user,
            session,
        }, null, 2),
    });
}

export async function createUserAndSession(message, ctx, args) {
    const tgId = message.from.id;

    let user = await db
        .select()
        .from(users)
        .where(eq(users.tg_id, tgId))
        .get();

    let firstInteraction = false

    if (!user) {
        firstInteraction = true

        user = await db
            .insert(users)
            .values({
                tg_id: tgId,
                username: message.from.username ?? null,
                first_name: message.from.first_name ?? null,
                last_name: message.from.last_name ?? null,
            })
            .returning()
            .get();
    }

    let session

    if (!firstInteraction) {
        session = await db
            .select()
            .from(sessions)
            .where(eq(sessions.user_id, user.id))
            .get();
    }

    if (!session) {
        session = await db
            .insert(sessions)
            .values({
                user_id: user.id,
                chat_id: message.chat.id,

                type: SessionType.Start,
                state: SessionState.Active,

                expires_at: new Date(
                    Date.now() + 24 * 60 * 60 * 1000
                ),
            })
            .returning()
            .get();
    }

    return {
        user,
        session
    }
}

export async function getUsers(message, ctx, args) {
    const rows = await db.select().from(users).all()

    await api.sendMessage({
        chat_id: message.chat.id,
        text: JSON.stringify(rows, null, 2),
    })
}