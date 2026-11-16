import { api, db } from 'sdk';
import { channelMembers as members, members as legacyMembers } from 'schema';
import { and, count, desc, eq, gte, isNull, lt, ne, sql } from 'sdk/db';
import { registerChannel } from 'lib/channels';

export const JOINED = 'join';
export const LEFT = 'left';
export const SOURCE_INVITE = 'invite_link';
export const SOURCE_USERNAME = 'username';

// Existing rows live in the legacy `members` table (unique by tg_id). They are
// copied once into `channel_members`, which is keyed by (chat_id, tg_id) and is
// the only table written from now on.
let membersSeeded = false;

async function ensureMembersSeeded() {
    if (membersSeeded) {
        return;
    }

    membersSeeded = true;

    const existing = await db.$count(members);

    if (existing > 0) {
        return;
    }

    await migrateLegacyMembers();
}

// Copies rows from the legacy `members` table into `channel_members`. Safe to
// run repeatedly: `INSERT OR IGNORE` only fills in missing (chat_id, tg_id)
// pairs and never overwrites rows written after the upgrade.
export async function migrateLegacyMembers() {
    const legacy = await db.$count(legacyMembers);

    if (!legacy) {
        return { legacy: 0, total: await db.$count(members) };
    }

    await db.run(sql`
        INSERT OR IGNORE INTO channel_members
            (chat_id, tg_id, status, source, invite_link, created_at, updated_at)
        SELECT
            chat_id, tg_id, status, source, invite_link, created_at, updated_at
        FROM members
    `);

    return { legacy, total: await db.$count(members) };
}

const DAY_START_OFFSET_MS = 3.5 * 60 * 60 * 1000;

export function startOfToday() {
    const shifted = Date.now() + DAY_START_OFFSET_MS;
    const dayStart = Math.floor(shifted / 86400000) * 86400000;

    return new Date(dayStart - DAY_START_OFFSET_MS);
}

const PRESENT_STATUSES = new Set(['member', 'administrator', 'creator']);

export function isPresent(member) {
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

    await ensureMembersSeeded();

    const oldMember = update.old_chat_member;
    const newMember = update.new_chat_member;
    const user = newMember?.user ?? oldMember?.user;

    if (!user || user.is_bot) {
        return;
    }

    // Any channel that reports membership is one the bot is admin in: make
    // sure it is listed so its report is reachable.
    await registerChannel(chat);

    const wasPresent = isPresent(oldMember);
    const isNowPresent = isPresent(newMember);

    if (!wasPresent && isNowPresent) {
        return await recordJoin(chat, user, update.invite_link);
    }

    if (wasPresent && !isNowPresent) {
        return await recordLeave(chat, user);
    }
}

async function findMember(chatId, tgId) {
    return await db
        .select()
        .from(members)
        .where(and(eq(members.chat_id, chatId), eq(members.tg_id, tgId)))
        .get();
}

async function recordJoin(chat, user, inviteLink) {
    const now = new Date();
    const source = inviteLink ? SOURCE_INVITE : SOURCE_USERNAME;
    const link = inviteLink
        ? inviteLink.name ?? inviteLink.invite_link ?? null
        : null;

    const existing = await findMember(chat.id, user.id);

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
            status: JOINED,
            source,
            invite_link: link,
            created_at: existing.created_at ?? now,
            updated_at: now,
        })
        .where(and(eq(members.chat_id, chat.id), eq(members.tg_id, user.id)))
        .run();
}

async function recordLeave(chat, user) {
    const now = new Date();
    const existing = await findMember(chat.id, user.id);

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
        .where(and(eq(members.chat_id, chat.id), eq(members.tg_id, user.id)))
        .run();
}

async function joinedBreakdown(chatId, startSec, sourceWhere) {
    const stayed = await db.$count(
        members,
        and(
            eq(members.chat_id, chatId),
            eq(members.status, JOINED),
            gte(members.updated_at, startSec),
            sourceWhere,
        ),
    );

    const leftAgain = await db.$count(
        members,
        and(
            eq(members.chat_id, chatId),
            eq(members.status, LEFT),
            gte(members.created_at, startSec),
            gte(members.updated_at, startSec),
            sourceWhere,
        ),
    );

    return { stayed, leftAgain, total: stayed + leftAgain };
}

async function inviteLinksBreakdown(chatId, startSec) {
    const stayedRows = await db
        .select({ link: members.invite_link, n: count() })
        .from(members)
        .where(
            and(
                eq(members.chat_id, chatId),
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
                eq(members.chat_id, chatId),
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

async function leftTrackedBeforeBreakdown(chatId, startSec) {
    const rows = await db
        .select({
            link: members.invite_link,
            source: members.source,
            n: count(),
        })
        .from(members)
        .where(
            and(
                eq(members.chat_id, chatId),
                eq(members.status, LEFT),
                gte(members.updated_at, startSec),
                lt(members.created_at, startSec),
            ),
        )
        .groupBy(members.invite_link, members.source)
        .all();

    const byLink = new Map();
    let other = 0;

    for (const row of rows) {
        const n = Number(row.n);

        if (row.source === SOURCE_INVITE) {
            const link = row.link ?? '(unnamed)';
            const entry = byLink.get(link) ?? { link, count: 0 };
            entry.count += n;
            byLink.set(link, entry);
        } else {
            other += n;
        }
    }

    const links = [...byLink.values()].sort((a, b) => b.count - a.count);

    return {
        total: links.reduce((sum, l) => sum + l.count, 0) + other,
        invite: links.reduce((sum, l) => sum + l.count, 0),
        byLink: links,
        other,
    };
}

export async function countPresent(chatId) {
    await ensureMembersSeeded();

    return await db.$count(
        members,
        and(eq(members.chat_id, chatId), eq(members.status, JOINED)),
    );
}

// How many users are tracked as present in both channels right now. The join
// runs in SQL so it stays fast for channels with many tracked members: the
// unique index on (chat_id, tg_id) serves the second channel's side.
export async function countSharedPresent(chatIdA, chatIdB) {
    await ensureMembersSeeded();

    const row = await db.get(sql`
        SELECT COUNT(*) AS n
        FROM channel_members AS a
        JOIN channel_members AS b ON b.tg_id = a.tg_id
        WHERE a.chat_id = ${chatIdA}
          AND a.status = ${JOINED}
          AND b.chat_id = ${chatIdB}
          AND b.status = ${JOINED}
    `);

    return Number(row?.n ?? 0);
}

// Live overlap check: asks the Bot API about each tracked member of the source
// channel instead of trusting the local rows. This is the expensive path — the
// Bot API rate-limits per call and the isolate has a wall-clock budget — so it
// is bounded by `limit`, runs in small batches, stops at a deadline and aborts
// as soon as Telegram reports flood control. The caller can pass an `offset` to
// walk the tracked list across several runs.
export const LIVE_CHECK_DEFAULT_LIMIT = 200;
export const LIVE_CHECK_MAX_LIMIT = 2000;
export const LIVE_CHECK_CONCURRENCY = 5;

const LIVE_CHECK_BUDGET_MS = 15000;

export async function liveSharedReport({
    sourceChatId,
    targetChatId,
    limit = LIVE_CHECK_DEFAULT_LIMIT,
    offset = 0,
}) {
    const totalTracked = await countPresent(sourceChatId);

    const rows = await db
        .select({ tg_id: members.tg_id })
        .from(members)
        .where(and(eq(members.chat_id, sourceChatId), eq(members.status, JOINED)))
        .orderBy(desc(members.updated_at), desc(members.id))
        .limit(limit)
        .offset(offset)
        .all();

    const ids = (rows ?? [])
        .map((row) => row.tg_id)
        .filter((id) => id != null);

    const deadline = Date.now() + LIVE_CHECK_BUDGET_MS;

    let present = 0;
    let absent = 0;
    let failed = 0;
    let rateLimited = false;
    let retryAfter = null;
    let timedOut = false;
    let firstError = null;

    const checkOne = async (tgId) => {
        try {
            const member = await api.getChatMember({
                chat_id: targetChatId,
                user_id: tgId,
            });

            return isPresent(member) ? 'present' : 'absent';
        } catch (e) {
            if (!firstError) {
                firstError = {
                    code: e?.code ?? null,
                    description: e?.description ?? e?.message ?? String(e),
                };
            }

            if (e?.code === 429) {
                rateLimited = true;
                retryAfter = Number(e?.parameters?.retry_after) || null;

                return 'rate_limited';
            }

            return 'failed';
        }
    };

    for (let i = 0; i < ids.length; i += LIVE_CHECK_CONCURRENCY) {
        if (Date.now() >= deadline) {
            timedOut = true;
            break;
        }

        const batch = ids.slice(i, i + LIVE_CHECK_CONCURRENCY);
        const results = await Promise.all(batch.map(checkOne));

        for (const result of results) {
            if (result === 'present') {
                present += 1;
            } else if (result === 'absent') {
                absent += 1;
            } else if (result === 'failed') {
                failed += 1;
            }
        }

        if (rateLimited) {
            break;
        }
    }

    const processed = present + absent + failed;

    return {
        totalTracked,
        offset,
        limit,
        requested: ids.length,
        processed,
        checked: present + absent,
        present,
        absent,
        failed,
        remainingTracked: Math.max(0, totalTracked - offset - processed),
        rateLimited,
        retryAfter,
        timedOut,
        firstError,
    };
}

export async function buildReport({ start, label, chatId }) {
    await ensureMembersSeeded();

    const startSec = Math.floor(start.getTime() / 1000);

    const joinedInvite = await joinedBreakdown(
        chatId,
        startSec,
        eq(members.source, SOURCE_INVITE),
    );

    joinedInvite.byLink = await inviteLinksBreakdown(chatId, startSec);

    const joinedOther = await joinedBreakdown(
        chatId,
        startSec,
        ne(members.source, SOURCE_INVITE),
    );

    const leftNoInfo = await db.$count(
        members,
        and(
            eq(members.chat_id, chatId),
            eq(members.status, LEFT),
            gte(members.updated_at, startSec),
            isNull(members.created_at),
        ),
    );

    const leftTrackedBefore = await leftTrackedBeforeBreakdown(chatId, startSec);

    const joinedLeft = joinedInvite.leftAgain + joinedOther.leftAgain;
    const joined = joinedInvite.total + joinedOther.total;
    const left = joinedLeft + leftNoInfo + leftTrackedBefore.total;

    return {
        label,
        start,
        joined,
        joinedInvite,
        joinedOther,
        joinedLeft,
        left,
        leftJoinedAndLeft: joinedLeft,
        leftTrackedBefore: leftTrackedBefore.total,
        leftTrackedBeforeInvite: leftTrackedBefore.invite,
        leftTrackedBeforeByLink: leftTrackedBefore.byLink,
        leftTrackedBeforeOther: leftTrackedBefore.other,
        leftNoInfo,
        net: joined - left,
    };
}
