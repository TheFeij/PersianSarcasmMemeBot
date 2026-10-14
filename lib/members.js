import { db } from 'sdk';
import { members } from 'schema';
import { and, count, eq, gte, isNull, lt, ne } from 'sdk/db';

export const JOINED = 'join';
export const LEFT = 'left';
export const SOURCE_INVITE = 'invite_link';
export const SOURCE_USERNAME = 'username';

const DAY_START_OFFSET_MS = 3.5 * 60 * 60 * 1000;

export function startOfToday() {
    const shifted = Date.now() + DAY_START_OFFSET_MS;
    const dayStart = Math.floor(shifted / 86400000) * 86400000;

    return new Date(dayStart - DAY_START_OFFSET_MS);
}

const PRESENT_STATUSES = new Set(['member', 'administrator', 'creator']);

function isPresent(member) {
    if (!member) {
        return false;
    }

    if (member.status === 'restricted') {
        return member.is_member === true;
    }

    return PRESENT_STATUSES.has(member.status);
}

export async function handleChatMember(update) {
    const chat = update?.chat;

    if (chat?.type !== 'channel') {
        return;
    }

    const oldMember = update.old_chat_member;
    const newMember = update.new_chat_member;
    const user = newMember?.user ?? oldMember?.user;

    if (!user || user.is_bot) {
        return;
    }

    const wasPresent = isPresent(oldMember);
    const isNowPresent = isPresent(newMember);

    if (!wasPresent && isNowPresent) {
        return await recordJoin(chat, user, update.invite_link);
    }

    if (wasPresent && !isNowPresent) {
        return await recordLeave(chat, user);
    }
}

async function findMember(tgId) {
    return await db
        .select()
        .from(members)
        .where(eq(members.tg_id, tgId))
        .get();
}

async function recordJoin(chat, user, inviteLink) {
    const now = new Date();
    const source = inviteLink ? SOURCE_INVITE : SOURCE_USERNAME;
    const link = inviteLink
        ? inviteLink.name ?? inviteLink.invite_link ?? null
        : null;

    const existing = await findMember(user.id);

    if (!existing) {
        await db
            .insert(members)
            .values({
                chat_id: chat.id,
                tg_id: user.id,
                status: JOINED,
                source,
                invite_link: link,
                created_at: now,
                updated_at: now,
            })
            .run();

        return;
    }

    await db
        .update(members)
        .set({
            chat_id: chat.id,
            status: JOINED,
            source,
            invite_link: link,
            created_at: existing.created_at ?? now,
            updated_at: now,
        })
        .where(eq(members.tg_id, user.id))
        .run();
}

async function recordLeave(chat, user) {
    const now = new Date();
    const existing = await findMember(user.id);

    if (!existing) {
        await db
            .insert(members)
            .values({
                chat_id: chat.id,
                tg_id: user.id,
                status: LEFT,
                source: null,
                invite_link: null,
                created_at: null,
                updated_at: now,
            })
            .run();

        return;
    }

    await db
        .update(members)
        .set({ status: LEFT, updated_at: now })
        .where(eq(members.tg_id, user.id))
        .run();
}

async function joinedBreakdown(startSec, sourceWhere) {
    const stayed = await db.$count(
        members,
        and(
            eq(members.status, JOINED),
            gte(members.updated_at, startSec),
            sourceWhere,
        ),
    );

    const leftAgain = await db.$count(
        members,
        and(
            eq(members.status, LEFT),
            gte(members.created_at, startSec),
            gte(members.updated_at, startSec),
            sourceWhere,
        ),
    );

    return { stayed, leftAgain, total: stayed + leftAgain };
}

async function inviteLinksBreakdown(startSec) {
    const stayedRows = await db
        .select({ link: members.invite_link, n: count() })
        .from(members)
        .where(
            and(
                eq(members.source, SOURCE_INVITE),
                eq(members.status, JOINED),
                gte(members.updated_at, startSec),
            ),
        )
        .groupBy(members.invite_link)
        .all();

    const leftRows = await db
        .select({ link: members.invite_link, n: count() })
        .from(members)
        .where(
            and(
                eq(members.source, SOURCE_INVITE),
                eq(members.status, LEFT),
                gte(members.created_at, startSec),
                gte(members.updated_at, startSec),
            ),
        )
        .groupBy(members.invite_link)
        .all();

    const byLink = new Map();

    for (const row of stayedRows) {
        const link = row.link ?? '(unnamed)';
        const entry = byLink.get(link) ?? { link, stayed: 0, leftAgain: 0 };
        entry.stayed += Number(row.n);
        byLink.set(link, entry);
    }

    for (const row of leftRows) {
        const link = row.link ?? '(unnamed)';
        const entry = byLink.get(link) ?? { link, stayed: 0, leftAgain: 0 };
        entry.leftAgain += Number(row.n);
        byLink.set(link, entry);
    }

    return [...byLink.values()]
        .map((e) => ({ ...e, total: e.stayed + e.leftAgain }))
        .sort((a, b) => b.total - a.total);
}

export async function buildReport({ start, label }) {
    const startSec = Math.floor(start.getTime() / 1000);

    const joinedInvite = await joinedBreakdown(
        startSec,
        eq(members.source, SOURCE_INVITE),
    );

    joinedInvite.byLink = await inviteLinksBreakdown(startSec);

    const joinedOther = await joinedBreakdown(
        startSec,
        ne(members.source, SOURCE_INVITE),
    );

    const leftNoInfo = await db.$count(
        members,
        and(
            eq(members.status, LEFT),
            gte(members.updated_at, startSec),
            isNull(members.created_at),
        ),
    );

    const leftTrackedBefore = await db.$count(
        members,
        and(
            eq(members.status, LEFT),
            gte(members.updated_at, startSec),
            lt(members.created_at, startSec),
        ),
    );

    const joinedLeft = joinedInvite.leftAgain + joinedOther.leftAgain;
    const joined = joinedInvite.total + joinedOther.total;
    const left = joinedLeft + leftNoInfo + leftTrackedBefore;

    return {
        label,
        start,
        joined,
        joinedInvite,
        joinedOther,
        joinedLeft,
        left,
        leftJoinedAndLeft: joinedLeft,
        leftTrackedBefore,
        leftNoInfo,
        net: joined - left,
    };
}
