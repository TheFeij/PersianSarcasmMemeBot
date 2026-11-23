import { api, db } from 'sdk';
import { adDraftItems, adDrafts, ads } from 'schema';
import { and, asc, eq, isNull, ne, or, sql } from 'sdk/db';
import {
    isPrivileged,
    adTimezoneOffsetMinutes,
    debugChatId,
    ownerTGID,
} from 'lib/config/config';
import { echo } from 'lib/debug';
import { clearButtonsPending } from 'lib/settings';
import {
    channelLabel,
    channelRef,
    findChannel,
    getChannelByChatId,
    listChannels,
} from 'lib/channels';

// Ads are built from messages the owner or an ad admin sends to the bot. Each
// content step stores references to the source message(s) and, when posting,
// copies them with copyMessage — or, for an album, re-sends them with
// sendMediaGroup — so media, captions, entities and formatting are preserved.
// Albums arrive as several separate updates sharing a media_group_id. Album
// members may be processed concurrently, so each one is staged as its own row
// in `ad_draft_items` (see stageItem) and the flow moves on as soon as the
// first member lands; the rest are absorbed silently.
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MEDIA_KINDS = new Set([
    'photo',
    'video',
    'animation',
    'audio',
    'document',
]);
const DRAFT_STEPS = new Set([
    'channel',
    'date',
    'preceding',
    'banner',
    'pin',
    'reply',
]);

const DATE_HELP =
    'Send the date in Gregorian format: YYYY-MM-DD, for example 2026-11-25.';

const MONTH_NAMES = [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
];

// The date an ad belongs to is a calendar day in the configured ad timezone,
// not UTC (otherwise "today" is off by one for a few hours every night).
function localDay(now = new Date()) {
    return new Date(now.getTime() + adTimezoneOffsetMinutes * 60000);
}

// Today plus the next `count - 1` days for the date keyboard.
function upcomingDates(count = 10, now = new Date()) {
    const shifted = localDay(now);
    const base = new Date(
        Date.UTC(
            shifted.getUTCFullYear(),
            shifted.getUTCMonth(),
            shifted.getUTCDate(),
        ),
    );
    const dates = [];

    for (let i = 0; i < count; i += 1) {
        const date = new Date(base.getTime() + i * 86400000);

        dates.push({
            iso: date.toISOString().slice(0, 10),
            label: `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCDate()}`,
        });
    }

    return dates;
}

function dateKeyboard() {
    const dates = upcomingDates(10);
    const rows = [];

    for (let i = 0; i < dates.length; i += 2) {
        rows.push(
            dates.slice(i, i + 2).map((date) => ({
                text: date.label,
                callback_data: `a:dt:${date.iso}`,
            })),
        );
    }

    return { inline_keyboard: rows };
}

export function todayISO(now = new Date()) {
    return localDay(now).toISOString().slice(0, 10);
}

export function parseAdDate(raw) {
    const match = String(raw ?? '')
        .trim()
        .match(DATE_RE);

    if (!match) {
        return null;
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));

    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    ) {
        return null;
    }

    return date.toISOString().slice(0, 10);
}

async function send(chatId, text, reply_markup) {
    return await api.sendMessage({
        chat_id: chatId,
        text,
        ...(reply_markup ? { reply_markup } : {}),
    });
}

// ---------------------------------------------------------------------------
// Draft state
// ---------------------------------------------------------------------------

export async function getAdDraft(ownerId) {
    return await dbGetDraft(ownerId);
}

async function dbGetDraft(ownerId) {
    return await db
        .select()
        .from(adDrafts)
        .where(eq(adDrafts.owner_tg_id, ownerId))
        .get();
}

async function writeDraft(ownerId, values) {
    const now = new Date();
    const row = { ...values };

    // `step` is NOT NULL and SQLite checks it on the INSERT row even when the
    // statement resolves to the conflict-update branch, so always carry the
    // current step forward unless the caller sets a new one.
    if (!row.step) {
        const existing = await dbGetDraft(ownerId);

        row.step = existing?.step ?? 'preceding';
    }

    await db
        .insert(adDrafts)
        .values({ owner_tg_id: ownerId, ...row, updated_at: now })
        .onConflictDoUpdate({
            target: adDrafts.owner_tg_id,
            set: { ...row, updated_at: now },
        })
        .run();
}

export async function clearAdDraft(ownerId) {
    await db
        .delete(adDraftItems)
        .where(eq(adDraftItems.owner_tg_id, ownerId))
        .run();
    await db.delete(adDrafts).where(eq(adDrafts.owner_tg_id, ownerId)).run();
}

// ---------------------------------------------------------------------------
// Staged content items
// ---------------------------------------------------------------------------
// Album members arrive as separate, possibly concurrent updates, so content is
// appended row by row instead of read-modify-writing a JSON array on the draft:
// two updates handling two members would otherwise overwrite each other and one
// image would be lost. The unique index makes a re-delivered update a no-op.

async function stageItem(ownerId, field, item) {
    await db.run(
        sql`INSERT OR IGNORE INTO ad_draft_items
                (owner_tg_id, field, chat_id, message_id, item)
            VALUES (${ownerId}, ${field}, ${item.chat_id}, ${item.message_id},
                    ${JSON.stringify(item)})`,
    );
}

async function stagedItems(ownerId, field) {
    const rows =
        (await db
            .select()
            .from(adDraftItems)
            .where(
                and(
                    eq(adDraftItems.owner_tg_id, ownerId),
                    eq(adDraftItems.field, field),
                ),
            )
            .orderBy(asc(adDraftItems.message_id))
            .all()) ?? [];

    return rows.map((row) => row.item);
}

async function clearStagedItems(ownerId, field) {
    await db
        .delete(adDraftItems)
        .where(
            and(
                eq(adDraftItems.owner_tg_id, ownerId),
                eq(adDraftItems.field, field),
            ),
        )
        .run();
}

// Records `groupId` as the album being collected for `field` and reports
// whether this update won the claim. Only the winner advances the flow, so two
// members processed at the same time do not both send the next prompt.
async function claimAlbum(ownerId, field, groupId) {
    if (!groupId) {
        return false;
    }

    const rows = await db
        .update(adDrafts)
        .set({ [`${field}_media_group_id`]: groupId })
        .where(
            and(
                eq(adDrafts.owner_tg_id, ownerId),
                or(
                    isNull(adDrafts[`${field}_media_group_id`]),
                    ne(adDrafts[`${field}_media_group_id`], groupId),
                ),
            ),
        )
        .returning({ id: adDrafts.id })
        .run();

    return Array.isArray(rows) && rows.length > 0;
}

// Mirrors staged items into the ad row while an edit is being collected. The
// read is repeated until two consecutive reads agree, so a member that lands
// between the read and the write cannot be dropped by the stale write.
async function syncStagedToAd(ownerId, adId, field, groupId) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const items = await stagedItems(ownerId, field);
        const values = {
            [`${field}_items`]: items.length ? items : null,
            [`${field}_media_group_id`]: groupId ?? null,
        };

        await updateAd(adId, values);

        const after = await stagedItems(ownerId, field);

        if (after.length === items.length) {
            return;
        }
    }
}

// ---------------------------------------------------------------------------
// Ad CRUD
// ---------------------------------------------------------------------------

async function getAdById(id) {
    if (!Number.isFinite(id)) {
        return null;
    }

    return await db.select().from(ads).where(eq(ads.id, id)).get();
}

async function loadAds() {
    return (
        (await db
            .select()
            .from(ads)
            .orderBy(asc(ads.ad_date), asc(ads.id))
            .all()) ?? []
    );
}

async function loadAdsForDate(date) {
    return (
        (await db
            .select()
            .from(ads)
            .where(eq(ads.ad_date, date))
            .orderBy(asc(ads.id))
            .all()) ?? []
    );
}

async function updateAd(id, values) {
    await db
        .update(ads)
        .set({ ...values, updated_at: new Date() })
        .where(eq(ads.id, id))
        .run();
}

// ---------------------------------------------------------------------------
// Ad content items
// ---------------------------------------------------------------------------

function mediaOf(message) {
    if (Array.isArray(message?.photo) && message.photo.length) {
        return {
            kind: 'photo',
            file_id: message.photo[message.photo.length - 1].file_id,
        };
    }

    for (const kind of ['video', 'animation', 'audio', 'document']) {
        if (message?.[kind]?.file_id) {
            return { kind, file_id: message[kind].file_id };
        }
    }

    return null;
}

// Everything needed to re-send this message later: the ids for copyMessage and,
// for albums, the media file id plus caption/entities for sendMediaGroup.
function messageItem(message) {
    const media = mediaOf(message);

    return {
        chat_id: message.chat.id,
        message_id: message.message_id,
        media_group_id: message.media_group_id ?? null,
        kind: media?.kind ?? null,
        file_id: media?.file_id ?? null,
        caption: message.caption ?? null,
        caption_entities: message.caption_entities ?? null,
    };
}

function itemsOf(record, field) {
    const stored = record?.[`${field}_items`];

    if (Array.isArray(stored) && stored.length) {
        return stored;
    }

    const chatId = record?.[`${field}_chat_id`];
    const messageId = record?.[`${field}_message_id`];

    if (chatId != null && messageId != null) {
        return [{ chat_id: chatId, message_id: messageId }];
    }

    return [];
}

function itemCount(record, field) {
    return itemsOf(record, field).length;
}

// ---------------------------------------------------------------------------
// Keyboards
// ---------------------------------------------------------------------------

function channelButtonLabel(channel) {
    const label = channel.username
        ? `@${channel.username}`
        : channel.title ?? String(channel.channel_chat_id);

    return label.length > 60 ? `${label.slice(0, 59)}…` : label;
}

function channelKeyboard(channels) {
    return {
        inline_keyboard: channels.map((channel) => [
            {
                text: channelButtonLabel(channel),
                callback_data: `a:ch:${channel.channel_chat_id}`,
            },
        ]),
    };
}

function pinKeyboard() {
    return {
        inline_keyboard: [
            [
                { text: '📌 Yes, pin it', callback_data: 'a:pn:1' },
                { text: 'No pin', callback_data: 'a:pn:0' },
            ],
        ],
    };
}

function skipKeyboard(field) {
    return {
        inline_keyboard: [
            [{ text: '⏭ Skip', callback_data: `a:sk:${field}` }],
        ],
    };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

async function askDate(chatId, channel) {
    return await send(
        chatId,
        `Choose the ad date for ${channel ? channelLabel(channel) : 'this ad'}:\n` +
            'the next 10 days are below, or send any date as YYYY-MM-DD.\n\n' +
            '/cancel to abort.',
        dateKeyboard(),
    );
}

async function askPreceding(chatId) {
    return await send(
        chatId,
        'Send the post that should appear just before the banner.\n' +
            'It can be text, a photo, a video — anything; formatting is kept ' +
            'and it is posted as a normal channel post.\n' +
            'Send one message or a whole album, or press Skip.',
        skipKeyboard('pre'),
    );
}

async function askBanner(chatId) {
    return await send(
        chatId,
        'Send the banner now (text, or media/album with caption; formatting ' +
            'is kept).\nThis message is required.\n\n/cancel to abort.',
    );
}

async function askPin(chatId) {
    return await send(
        chatId,
        'Should the banner be pinned in the channel?',
        pinKeyboard(),
    );
}

async function askReply(chatId) {
    return await send(
        chatId,
        'Send the reply text to post under the banner, or press Skip.',
        skipKeyboard('rep'),
    );
}

// ---------------------------------------------------------------------------
// Create flow
// ---------------------------------------------------------------------------

export async function startAdCreate(chatId, ownerId) {
    await clearAdDraft(ownerId);

    if (ownerId === ownerTGID) {
        await clearButtonsPending();
    }

    const channels = await listChannels({ activeOnly: true });

    if (!channels.length) {
        return await send(
            chatId,
            'No channels registered yet. Add the bot to a channel as admin ' +
                'first.',
        );
    }

    if (channels.length === 1) {
        await writeDraft(ownerId, {
            step: 'date',
            channel_chat_id: channels[0].channel_chat_id,
        });

        return await askDate(chatId, channels[0]);
    }

    await writeDraft(ownerId, { step: 'channel' });

    return await send(
        chatId,
        'Which channel is this ad for?',
        channelKeyboard(channels),
    );
}

async function applyDraftDate(ownerId, chatId, date) {
    const draft = await getAdDraft(ownerId);

    if (!draft) {
        return await send(chatId, 'No ad flow is in progress. Use /setadd.');
    }

    if (draft.step !== 'date') {
        return await send(
            chatId,
            'That date button is from an older step. Answer the current ' +
                'prompt, or /cancel.',
        );
    }

    if (draft.editing_ad_id) {
        await updateAd(draft.editing_ad_id, { ad_date: date });
        await clearAdDraft(ownerId);

        return await sendAdDetail(
            chatId,
            await getAdById(draft.editing_ad_id),
        );
    }

    await writeDraft(ownerId, { step: 'preceding', ad_date: date });

    return await askPreceding(chatId);
}

export async function handleAdDraftMessage(ownerId, message) {
    const draft = await getAdDraft(ownerId);

    if (!draft) {
        return false;
    }

    const chatId = message.chat.id;
    const text = (message.text ?? '').trim();

    await echo(chatId, 'ads: draft step', {
        step: draft.step,
        editing_ad_id: draft.editing_ad_id,
        media_group_id: message.media_group_id ?? null,
    });

    // A later member of an album belongs to the content step that album
    // started, even when the flow has already moved on to the next prompt.
    // It is appended silently and never re-prompts.
    const albumField = openAlbumField(draft, message);

    if (albumField) {
        await appendAlbumItem(ownerId, draft, message, albumField);
        return true;
    }

    // An edited album keeps its draft open only to absorb trailing members;
    // the owner's next unrelated message ends the collection.
    if (draft.step === 'album') {
        await clearAdDraft(ownerId);
        return false;
    }

    if (!DRAFT_STEPS.has(draft.step)) {
        return false;
    }

    switch (draft.step) {
        case 'channel':
            await send(chatId, 'Tap one of the channel buttons above, or /cancel.');
            return true;

        case 'date': {
            const date = parseAdDate(text);

            if (!date) {
                await send(
                    chatId,
                    `That is not a valid date.\n${DATE_HELP}\n` +
                        'Or pick one from the buttons above.',
                );
                return true;
            }

            return await applyDraftDate(ownerId, chatId, date);
        }

        case 'preceding':
            return await collectContent(
                ownerId,
                draft,
                message,
                chatId,
                'preceding',
            );

        case 'banner':
            return await collectContent(
                ownerId,
                draft,
                message,
                chatId,
                'banner',
            );

        case 'pin':
            await send(
                chatId,
                'Pick Yes or No for pinning above, or /cancel.',
            );
            return true;

        case 'reply': {
            const replyText = text || (message.caption ?? '').trim();

            if (!replyText) {
                await send(chatId, 'Send the reply as text, or press Skip.');
                return true;
            }

            if (draft.editing_ad_id) {
                await updateAd(draft.editing_ad_id, { reply_text: replyText });
                await clearAdDraft(ownerId);

                return await sendAdDetail(
                    chatId,
                    await getAdById(draft.editing_ad_id),
                );
            }

            await writeDraft(ownerId, { reply_text: replyText });

            return await finalizeDraft(ownerId, chatId);
        }

        default:
            return false;
    }
}

// Which album (if any) the incoming message belongs to. The first member of a
// new album matches nothing yet and is handled by collectContent.
function openAlbumField(draft, message) {
    const groupId = message.media_group_id;

    if (!groupId) {
        return null;
    }

    if (draft.preceding_media_group_id === groupId) {
        return 'preceding';
    }

    if (draft.banner_media_group_id === groupId) {
        return 'banner';
    }

    return null;
}

async function appendAlbumItem(ownerId, draft, message, field) {
    await stageItem(ownerId, field, messageItem(message));

    if (draft.editing_ad_id) {
        await syncStagedToAd(
            ownerId,
            draft.editing_ad_id,
            field,
            draft[`${field}_media_group_id`] ?? null,
        );
    }

    return true;
}

async function collectContent(ownerId, draft, message, chatId, field) {
    const item = messageItem(message);
    const groupId = message.media_group_id ?? null;
    const isAlbum = Boolean(groupId);

    // Claim the album before staging, so only one of several concurrent
    // members advances the flow; the rest drop through as plain appends.
    const first = isAlbum ? await claimAlbum(ownerId, field, groupId) : true;

    await stageItem(ownerId, field, item);

    if (!first) {
        if (draft.editing_ad_id) {
            await syncStagedToAd(
                ownerId,
                draft.editing_ad_id,
                field,
                groupId,
            );
        }

        return true;
    }

    const values = { [`${field}_media_group_id`]: groupId };

    if (draft.editing_ad_id) {
        // Stay on a neutral step while the rest of the album is still in
        // flight, so its members keep being appended; the owner's next
        // unrelated message ends the collection.
        values.step = isAlbum ? 'album' : draft.step;

        await writeDraft(ownerId, values);
        await syncStagedToAd(ownerId, draft.editing_ad_id, field, groupId);

        if (!isAlbum) {
            await clearAdDraft(ownerId);
        }

        return await sendAdDetail(
            chatId,
            await getAdById(draft.editing_ad_id),
        );
    }

    await writeDraft(ownerId, values);

    return await advanceFromContent(ownerId, chatId, field);
}

async function advanceFromContent(ownerId, chatId, field) {
    if (field === 'preceding') {
        await writeDraft(ownerId, { step: 'banner' });

        return await askBanner(chatId);
    }

    await writeDraft(ownerId, { step: 'pin' });

    return await askPin(chatId);
}

async function finalizeDraft(ownerId, chatId) {
    const draft = await getAdDraft(ownerId);
    // Album members are staged row by row while the flow runs; by the time the
    // owner reaches the reply step every member has landed.
    const preceding = await stagedItems(ownerId, 'preceding');
    const banner = await stagedItems(ownerId, 'banner');

    if (
        !draft ||
        draft.channel_chat_id == null ||
        !draft.ad_date ||
        !banner.length
    ) {
        await clearAdDraft(ownerId);

        return await send(
            chatId,
            'The ad is incomplete and was not saved. Start again with ' +
                '/setadd.',
        );
    }

    const now = new Date();
    const rows = await db
        .insert(ads)
        .values({
            channel_chat_id: draft.channel_chat_id,
            ad_date: draft.ad_date,
            preceding_items: preceding.length ? preceding : null,
            preceding_media_group_id:
                draft.preceding_media_group_id ?? null,
            banner_items: banner,
            banner_media_group_id: draft.banner_media_group_id ?? null,
            pin_banner: draft.pin_banner === true,
            reply_text: draft.reply_text ?? null,
            created_at: now,
            updated_at: now,
        })
        .returning()
        .run();

    await clearAdDraft(ownerId);

    const created = rows?.[0] ?? null;
    const channel = await getChannelByChatId(draft.channel_chat_id);

    await send(
        chatId,
        `Ad saved for ${draft.ad_date}` +
            (channel ? ` on ${channelLabel(channel)}` : '') +
            '.',
    );

    if (created) {
        return await sendAdDetail(chatId, created);
    }

    return await showAdsList(chatId);
}

// ---------------------------------------------------------------------------
// Ads management
// ---------------------------------------------------------------------------

function formatPosted(ad) {
    if (!ad.posted_at) {
        return 'not posted';
    }

    const date = localDay(new Date(ad.posted_at));

    if (Number.isNaN(date.getTime())) {
        return 'posted';
    }

    return `posted ${date.toISOString().slice(0, 16).replace('T', ' ')}`;
}

function adLine(ad, channel) {
    const where = channel ? channelRef(channel) : ad.channel_chat_id;

    return (
        `${ad.ad_date} · ${where} · #${ad.id}` +
        (ad.posted_at ? ' · ✅' : '')
    );
}

export async function showAdsList(chatId) {
    const all = await loadAds();
    const channels = await listChannels();
    const byId = new Map(channels.map((c) => [c.channel_chat_id, c]));

    if (!all.length) {
        return await send(
            chatId,
            'No ads yet. Create one with /setadd.',
        );
    }

    const shown = all.slice(0, 40);
    const keyboard = shown.map((ad) => [
        {
            text: adLine(ad, byId.get(ad.channel_chat_id)),
            callback_data: `a:v:${ad.id}`,
        },
    ]);

    keyboard.push([{ text: '➕ New ad', callback_data: 'a:n' }]);

    return await send(
        chatId,
        `Ads (${all.length}). Tap one to manage it:`,
        { inline_keyboard: keyboard },
    );
}

export async function sendAdDetail(chatId, ad) {
    if (!ad) {
        return await send(chatId, 'Ad not found.');
    }

    const channel = await getChannelByChatId(ad.channel_chat_id);
    const reply = ad.reply_text
        ? ad.reply_text.slice(0, 200)
        : 'not set';
    const precedingCount = itemCount(ad, 'preceding');
    const bannerCount = itemCount(ad, 'banner');

    const lines = [
        `Ad #${ad.id}`,
        `Channel: ${channel ? channelLabel(channel) : ad.channel_chat_id}`,
        `Date: ${ad.ad_date}`,
        `Status: ${formatPosted(ad)}`,
        `Preceding post: ${
            precedingCount
                ? `${precedingCount} item${precedingCount === 1 ? '' : 's'}`
                : 'not set'
        }`,
        `Banner: ${
            bannerCount
                ? `${bannerCount} item${bannerCount === 1 ? '' : 's'}`
                : 'missing'
        }`,
        `Pin banner: ${ad.pin_banner ? 'yes' : 'no'}`,
        `Reply: ${reply}`,
    ];

    return await send(chatId, lines.join('\n'), {
        inline_keyboard: [
            [
                { text: '📅 Date', callback_data: `a:d:${ad.id}` },
                { text: '📣 Channel', callback_data: `a:c:${ad.id}` },
            ],
            [
                {
                    text: '⬆️ Preceding post',
                    callback_data: `a:p:${ad.id}`,
                },
                { text: '🖼 Banner', callback_data: `a:b:${ad.id}` },
            ],
            [
                {
                    text: ad.pin_banner ? '📌 Pin: ON' : '📌 Pin: OFF',
                    callback_data: `a:t:${ad.id}`,
                },
                { text: '💬 Reply', callback_data: `a:r:${ad.id}` },
            ],
            [
                { text: '👁 Preview', callback_data: `a:pv:${ad.id}` },
                { text: '🚀 Post now', callback_data: `a:g:${ad.id}` },
            ],
            [
                { text: '🗑 Delete', callback_data: `a:x:${ad.id}` },
                { text: '⬅️ All ads', callback_data: 'a:l' },
            ],
        ],
    });
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

async function postItems(chatId, items, warnings) {
    if (!items.length) {
        return [];
    }

    if (items.length === 1) {
        const copied = await api.copyMessage({
            chat_id: chatId,
            from_chat_id: items[0].chat_id,
            message_id: items[0].message_id,
        });

        return [copied];
    }

    const groupable = items.every(
        (item) => item.file_id && MEDIA_KINDS.has(item.kind),
    );

    if (groupable) {
        try {
            const media = items.map((item) => ({
                type: item.kind,
                media: item.file_id,
                ...(item.caption ? { caption: item.caption } : {}),
                ...(Array.isArray(item.caption_entities) &&
                item.caption_entities.length
                    ? { caption_entities: item.caption_entities }
                    : {}),
            }));

            return await api.sendMediaGroup({ chat_id: chatId, media });
        } catch (e) {
            warnings.push(
                'Album could not be sent as one group, sending the items ' +
                    `separately: ${botErrorText(e)}`,
            );
        }
    }

    const messages = [];

    for (const item of items) {
        messages.push(
            await api.copyMessage({
                chat_id: chatId,
                from_chat_id: item.chat_id,
                message_id: item.message_id,
            }),
        );
    }

    return messages;
}

async function postAdCore(ad, chatId) {
    const warnings = [];
    const preceding = itemsOf(ad, 'preceding');
    const banner = itemsOf(ad, 'banner');

    if (!banner.length) {
        return { ok: false, error: `Ad #${ad.id} has no banner.` };
    }

    await echo(chatId, 'ads: posting', {
        ad_id: ad.id,
        chat_id: chatId,
        preview: chatId !== ad.channel_chat_id,
        preceding: preceding.length,
        banner: banner.length,
    });

    if (preceding.length) {
        try {
            await postItems(chatId, preceding, warnings);
        } catch (e) {
            return stepFailed('preceding post', e);
        }
    }

    let bannerMessages;

    try {
        bannerMessages = await postItems(chatId, banner, warnings);
    } catch (e) {
        return stepFailed('banner', e);
    }

    const anchorId = bannerMessages?.[0]?.message_id;

    if (ad.pin_banner && anchorId != null) {
        try {
            await api.pinChatMessage({
                chat_id: chatId,
                message_id: anchorId,
                disable_notification: true,
            });
        } catch (e) {
            warnings.push(`Pinning failed: ${botErrorText(e)}`);
        }
    }

    if (ad.reply_text && anchorId != null) {
        try {
            await api.sendMessage({
                chat_id: chatId,
                text: ad.reply_text,
                reply_parameters: {
                    message_id: anchorId,
                    allow_sending_without_reply: true,
                },
            });
        } catch (e) {
            // Channels do not always accept replies; fall back to a plain
            // message so the reply text is still posted.
            try {
                await api.sendMessage({
                    chat_id: chatId,
                    text: ad.reply_text,
                });
                warnings.push(
                    `Reply was posted as a normal message: ${botErrorText(e)}`,
                );
            } catch (e2) {
                warnings.push(`Reply failed: ${botErrorText(e2)}`);
            }
        }
    }

    return {
        ok: true,
        ad,
        warnings,
        bannerMessageId: anchorId,
    };
}

export async function postAdById(id) {
    const ad = await getAdById(id);

    if (!ad) {
        return { ok: false, error: `Ad #${id} not found.` };
    }

    const result = await postAdCore(ad, ad.channel_chat_id);

    if (result.ok) {
        await updateAd(ad.id, { posted_at: new Date() });
    }

    return result;
}

// Plays the whole sequence in the debug chat (or the caller's chat when no
// debug chat is configured) without touching the channel or posted_at.
export async function previewAdById(id) {
    const ad = await getAdById(id);

    if (!ad) {
        return { ok: false, error: `Ad #${id} not found.` };
    }

    const target = debugChatId || ownerTGID;
    const result = await postAdCore(ad, target);

    return { ...result, preview: true };
}

function stepFailed(step, e) {
    return {
        ok: false,
        error: `Could not post the ${step}: ${botErrorText(e)}`,
    };
}

function botErrorText(e) {
    return e?.description ?? e?.message ?? String(e);
}

function resultText(result, channel) {
    if (!result.ok) {
        return result.error;
    }

    if (result.preview) {
        const lines = [
            `Previewed ad #${result.ad.id} for ${result.ad.ad_date}` +
                (channel ? ` (target: ${channelLabel(channel)})` : '') +
                '.',
        ];

        if (result.warnings.length) {
            lines.push('', ...result.warnings);
        }

        return lines.join('\n');
    }

    const lines = [
        `Posted ad #${result.ad.id}` +
            (channel ? ` to ${channelLabel(channel)}` : '') +
            ` for ${result.ad.ad_date}.`,
    ];

    if (result.warnings.length) {
        lines.push('', ...result.warnings);
    }

    return lines.join('\n');
}

export async function postAdCommand(message, args) {
    const chatId = message.chat.id;
    let raw = args.join(' ').trim();

    // `/sendadd today` and `/postad today` mean the same as no date at all.
    if (raw.toLowerCase() === 'today') {
        raw = '';
    }

    let date = todayISO();

    if (raw) {
        const parsed = parseAdDate(raw);

        if (!parsed) {
            return await send(
                chatId,
                `Usage: /sendadd [today] or /postad [YYYY-MM-DD]\n` +
                    `Without a date it posts today's ad (${date}).`,
            );
        }

        date = parsed;
    }

    const candidates = await loadAdsForDate(date);

    await echo(chatId, 'ads: postad', {
        date,
        candidates: candidates.map((ad) => ad.id),
    });

    if (!candidates.length) {
        return await send(chatId, `No ad is scheduled for ${date}.`);
    }

    if (candidates.length === 1) {
        const ad = candidates[0];
        const channel = await getChannelByChatId(ad.channel_chat_id);

        if (ad.posted_at) {
            return await send(
                chatId,
                `Ad #${ad.id} for ${ad.ad_date} was already posted ` +
                    `(${formatPosted(ad)}). Post it again?`,
                {
                    inline_keyboard: [
                        [
                            {
                                text: '🚀 Post again',
                                callback_data: `a:g:${ad.id}`,
                            },
                            {
                                text: 'Cancel',
                                callback_data: `a:v:${ad.id}`,
                            },
                        ],
                    ],
                },
            );
        }

        const result = await postAdById(ad.id);

        return await send(chatId, resultText(result, channel));
    }

    const channels = await listChannels();
    const byId = new Map(channels.map((c) => [c.channel_chat_id, c]));

    return await send(
        chatId,
        `Several ads are scheduled for ${date}. Which one should I post?`,
        {
            inline_keyboard: candidates.map((ad) => [
                {
                    text: adLine(ad, byId.get(ad.channel_chat_id)),
                    callback_data: `a:g:${ad.id}`,
                },
            ]),
        },
    );
}

// `/sendadd <channel> [today|YYYY-MM-DD]` posts the ad for one channel. The
// channel is required so it is never ambiguous which channel is targeted.
export async function sendAdCommand(message, args) {
    const chatId = message.chat.id;
    const refParts = [];
    let date = todayISO();
    let badDate = null;

    for (const arg of args) {
        if (arg.toLowerCase() === 'today') {
            continue;
        }

        if (DATE_RE.test(arg)) {
            const parsed = parseAdDate(arg);

            if (parsed) {
                date = parsed;
            } else {
                badDate = arg;
            }

            continue;
        }

        refParts.push(arg);
    }

    const ref = refParts.join(' ').trim();

    if (badDate) {
        return await send(
            chatId,
            `That is not a valid date: ${badDate}.\n${DATE_HELP}`,
        );
    }

    if (!ref) {
        return await send(
            chatId,
            'Usage: /sendadd <channel> [today|YYYY-MM-DD]\n' +
                'For example: /sendadd @mychannel today',
        );
    }

    const channel = await findChannel(ref);

    if (!channel) {
        return await send(
            chatId,
            `Channel ${ref} is not registered. Use /status to see the ` +
                'available channels.',
        );
    }

    const candidates = (await loadAdsForDate(date)).filter(
        (ad) => ad.channel_chat_id === channel.channel_chat_id,
    );

    await echo(chatId, 'ads: sendadd', {
        date,
        channel: channel.channel_chat_id,
        candidates: candidates.map((ad) => ad.id),
    });

    if (!candidates.length) {
        return await send(
            chatId,
            `No ad is scheduled for ${date} on ${channelRef(channel)}.`,
        );
    }

    if (candidates.length === 1) {
        const ad = candidates[0];

        if (ad.posted_at) {
            return await send(
                chatId,
                `Ad #${ad.id} for ${ad.ad_date} was already posted ` +
                    `(${formatPosted(ad)}). Post it again?`,
                {
                    inline_keyboard: [
                        [
                            {
                                text: '🚀 Post again',
                                callback_data: `a:g:${ad.id}`,
                            },
                            {
                                text: 'Cancel',
                                callback_data: `a:v:${ad.id}`,
                            },
                        ],
                    ],
                },
            );
        }

        const result = await postAdById(ad.id);

        return await send(chatId, resultText(result, channel));
    }

    return await send(
        chatId,
        `Several ads are scheduled for ${date} on ` +
            `${channelRef(channel)}. Which one should I post?`,
        {
            inline_keyboard: candidates.map((ad) => [
                {
                    text: adLine(ad, channel),
                    callback_data: `a:g:${ad.id}`,
                },
            ]),
        },
    );
}

// ---------------------------------------------------------------------------
// Edit helpers
// ---------------------------------------------------------------------------

// Plays the ad in the debug chat without posting it to the channel.
export async function previewAdCommand(message, args) {
    const chatId = message.chat.id;
    const raw = args.join(' ').trim();
    let date = todayISO();

    if (raw) {
        const parsed = parseAdDate(raw);

        if (!parsed) {
            return await send(
                chatId,
                `Usage: /previewad [YYYY-MM-DD]\nWithout a date it previews ` +
                    `today's ad (${date}).`,
            );
        }

        date = parsed;
    }

    const candidates = await loadAdsForDate(date);

    await echo(chatId, 'ads: previewad', {
        date,
        candidates: candidates.map((ad) => ad.id),
    });

    if (!candidates.length) {
        return await send(chatId, `No ad is scheduled for ${date}.`);
    }

    if (candidates.length === 1) {
        const ad = candidates[0];
        const channel = await getChannelByChatId(ad.channel_chat_id);
        const result = await previewAdById(ad.id);

        return await send(chatId, resultText(result, channel));
    }

    const channels = await listChannels();
    const byId = new Map(channels.map((c) => [c.channel_chat_id, c]));

    return await send(
        chatId,
        `Several ads are scheduled for ${date}. Which one should I preview?`,
        {
            inline_keyboard: candidates.map((ad) => [
                {
                    text: adLine(ad, byId.get(ad.channel_chat_id)),
                    callback_data: `a:pv:${ad.id}`,
                },
            ]),
        },
    );
}

async function beginEdit(ownerId, chatId, adId, step) {
    const ad = await getAdById(adId);

    if (!ad) {
        return await send(chatId, 'Ad not found.');
    }

    await clearAdDraft(ownerId);

    if (ownerId === ownerTGID) {
        await clearButtonsPending();
    }

    await writeDraft(ownerId, { step, editing_ad_id: ad.id });

    switch (step) {
        case 'channel': {
            const channels = await listChannels({ activeOnly: true });

            return await send(
                chatId,
                `Choose the new channel for ad #${ad.id}.`,
                channelKeyboard(channels),
            );
        }

        case 'date':
            return await askDate(chatId, await getChannelByChatId(ad.channel_chat_id));

        case 'preceding':
            return await askPreceding(chatId);

        case 'banner':
            return await askBanner(chatId);

        case 'reply':
            return await askReply(chatId);

        default:
            return await send(chatId, 'Unknown field.');
    }
}

async function finishEdit(ownerId, chatId, adId, values) {
    await updateAd(adId, values);
    await clearAdDraft(ownerId);

    return await sendAdDetail(chatId, await getAdById(adId));
}

async function chooseChannel(ownerId, chatId, rawId) {
    const channelChatId = Number(rawId);

    if (!Number.isFinite(channelChatId)) {
        return await send(chatId, 'Unknown channel.');
    }

    const draft = await getAdDraft(ownerId);

    if (!draft) {
        return await send(chatId, 'No ad flow is in progress. Use /setadd.');
    }

    if (draft.step !== 'channel') {
        return await send(
            chatId,
            'That channel button is from an older step. Answer the current ' +
                'prompt, or /cancel.',
        );
    }

    if (draft.editing_ad_id) {
        return await finishEdit(ownerId, chatId, draft.editing_ad_id, {
            channel_chat_id: channelChatId,
        });
    }

    await writeDraft(ownerId, {
        step: 'date',
        channel_chat_id: channelChatId,
    });

    return await askDate(chatId, await getChannelByChatId(channelChatId));
}

async function choosePin(ownerId, chatId, enabled) {
    const draft = await getAdDraft(ownerId);

    if (!draft) {
        return await send(chatId, 'No ad flow is in progress. Use /setadd.');
    }

    if (draft.step !== 'pin') {
        return await send(
            chatId,
            'That pin button is from an older step. Answer the current ' +
                'prompt, or /cancel.',
        );
    }
    if (draft.editing_ad_id) {
        return await finishEdit(ownerId, chatId, draft.editing_ad_id, {
            pin_banner: enabled,
        });
    }

    await writeDraft(ownerId, { step: 'reply', pin_banner: enabled });

    return await askReply(chatId);
}

async function skipField(ownerId, chatId, field) {
    const draft = await getAdDraft(ownerId);

    if (!draft) {
        return await send(chatId, 'No ad flow is in progress. Use /setadd.');
    }

    if (field === 'pre' && draft.step !== 'preceding') {
        return await send(
            chatId,
            'That Skip button is from an older step. Answer the current ' +
                'prompt, or /cancel.',
        );
    }

    if (field === 'rep' && draft.step !== 'reply') {
        return await send(
            chatId,
            'That Skip button is from an older step. Answer the current ' +
                'prompt, or /cancel.',
        );
    }

    if (field === 'pre') {
        if (draft.editing_ad_id) {
            return await finishEdit(ownerId, chatId, draft.editing_ad_id, {
                preceding_chat_id: null,
                preceding_message_id: null,
                preceding_items: null,
                preceding_media_group_id: null,
            });
        }

        await clearStagedItems(ownerId, 'preceding');
        await writeDraft(ownerId, {
            step: 'banner',
            preceding_chat_id: null,
            preceding_message_id: null,
            preceding_items: null,
            preceding_media_group_id: null,
        });

        return await askBanner(chatId);
    }

    if (field === 'rep') {
        if (draft.editing_ad_id) {
            return await finishEdit(ownerId, chatId, draft.editing_ad_id, {
                reply_text: null,
            });
        }

        await writeDraft(ownerId, { reply_text: null });

        return await finalizeDraft(ownerId, chatId);
    }

    return await send(chatId, 'Unknown skip option.');
}

async function togglePin(chatId, adId) {
    const ad = await getAdById(adId);

    if (!ad) {
        return await send(chatId, 'Ad not found.');
    }

    await updateAd(ad.id, { pin_banner: ad.pin_banner !== true });

    return await sendAdDetail(chatId, await getAdById(ad.id));
}

async function confirmDelete(chatId, adId) {
    const ad = await getAdById(adId);

    if (!ad) {
        return await send(chatId, 'Ad not found.');
    }

    return await send(
        chatId,
        `Delete ad #${ad.id} (${ad.ad_date})? This cannot be undone.`,
        {
            inline_keyboard: [
                [
                    { text: '🗑 Yes, delete', callback_data: `a:xy:${ad.id}` },
                    { text: 'Cancel', callback_data: `a:xn:${ad.id}` },
                ],
            ],
        },
    );
}

async function deleteAd(chatId, adId) {
    await db.delete(ads).where(eq(ads.id, adId)).run();
    await send(chatId, `Ad #${adId} deleted.`);

    return await showAdsList(chatId);
}

async function postAndReport(chatId, adId) {
    const ad = await getAdById(adId);
    const channel = ad ? await getChannelByChatId(ad.channel_chat_id) : null;
    const result = await postAdById(adId);

    return await send(chatId, resultText(result, channel));
}

async function previewAndReport(chatId, adId) {
    const ad = await getAdById(adId);
    const channel = ad ? await getChannelByChatId(ad.channel_chat_id) : null;
    const result = await previewAdById(adId);

    return await send(chatId, resultText(result, channel));
}

// ---------------------------------------------------------------------------
// Callback router
// ---------------------------------------------------------------------------

export async function handleAdCallback(query) {
    const data = String(query?.data ?? '');

    if (!data.startsWith('a:')) {
        return false;
    }

    try {
        await api.answerCallbackQuery({ callback_query_id: query.id });
    } catch (e) {
        console.error(
            '[ads] answerCallbackQuery failed:',
            e?.description ?? e?.message ?? e,
        );
    }

    if (!isPrivileged(query?.from?.id)) {
        return true;
    }

    const chatId = query?.message?.chat?.id;

    if (chatId == null) {
        return true;
    }

    const [, action, ...rest] = data.split(':');
    const arg = rest.join(':');
    const ownerId = query.from.id;

    await echo(chatId, 'ads: callback', { action, arg });

    switch (action) {
        case 'l':
            return await showAdsList(chatId);

        case 'n':
            return await startAdCreate(chatId, ownerId);

        case 'ch':
            return await chooseChannel(ownerId, chatId, arg);

        case 'dt': {
            const date = parseAdDate(arg);

            if (!date) {
                return await send(chatId, 'Invalid date button.');
            }

            return await applyDraftDate(ownerId, chatId, date);
        }

        case 'pn':
            return await choosePin(ownerId, chatId, arg === '1');

        case 'sk':
            return await skipField(ownerId, chatId, arg);

        case 'fd':
            return await send(
                chatId,
                'Albums are captured automatically now — no Done needed.',
            );

        case 'cc':
            await clearAdDraft(ownerId);

            return await send(chatId, 'Cancelled.');

        case 'v':
            return await sendAdDetail(chatId, await getAdById(Number(arg)));

        case 'd':
            return await beginEdit(ownerId, chatId, Number(arg), 'date');

        case 'c':
            return await beginEdit(ownerId, chatId, Number(arg), 'channel');

        case 'p':
            return await beginEdit(ownerId, chatId, Number(arg), 'preceding');

        case 'b':
            return await beginEdit(ownerId, chatId, Number(arg), 'banner');

        case 'r':
            return await beginEdit(ownerId, chatId, Number(arg), 'reply');

        case 't':
            return await togglePin(chatId, Number(arg));

        case 'x':
            return await confirmDelete(chatId, Number(arg));

        case 'xy':
            return await deleteAd(chatId, Number(arg));

        case 'xn':
            return await sendAdDetail(chatId, await getAdById(Number(arg)));

        case 'g':
            return await postAndReport(chatId, Number(arg));

        case 'pv':
            return await previewAndReport(chatId, Number(arg));

        default:
            return await send(chatId, 'Unknown action.');
    }
}
