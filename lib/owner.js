import { api } from 'sdk';
import { ownerTGID } from 'lib/config/config';
import { echo } from 'lib/debug';
import {
    buildReport,
    countPresent,
    countSharedPresent,
    LIVE_CHECK_DEFAULT_LIMIT,
    LIVE_CHECK_MAX_LIMIT,
    liveSharedReport,
    migrateLegacyMembers,
    startOfToday,
} from 'lib/members';
import {
    clearButtonsPending,
    getSettings,
    setDebug,
} from 'lib/settings';
import {
    channelLabel,
    channelRef,
    channelTitle,
    findChannel,
    getChannelByChatId,
    listChannels,
    linkedChannelId,
    registerChannel,
    resetChannel,
    resolveChannel,
    setButtons,
    setGroupChatId,
    setPhrase,
    setPinPattern,
} from 'lib/channels';
import {
    applyButtons,
    buildKeyboard,
    BUTTON_SYNTAX_HINT,
    formatButtons,
    formatTarget,
    parseButtons,
    saveGlobalButtons,
    setGlobalButtonsEnabled,
    startGlobalButtonsFlow,
    startPostFlow,
    targetFromForward,
    targetFromLink,
} from 'lib/buttons';

const BUTTON_SUBS = new Set(['on', 'off', 'set', 'show', 'clear', 'help']);

export async function handleOwnerMessage(message) {
    const chatId = message.chat.id;

    if (message.from?.id !== ownerTGID) {
        return;
    }

    const text = (message.text ?? '').trim();
    const [rawCommand, ...args] = text.split(/\s+/);
    const command = rawCommand.split('@')[0];
    const isCommand = text.startsWith('/');

    await echo(chatId, 'owner: command', {
        command: isCommand ? command : null,
        args,
    });

    try {
        const settings = await getSettings();
        const pending = settings?.buttons_pending ?? null;

        if (isCommand) {
            if (pending && command !== '/cancel') {
                await clearButtonsPending();
            }

            switch (command) {
                case '/start':
                case '/help':
                    return await sendHelp(message);

                case '/status':
                case '/channels':
                    return await sendStatus(message, args);

                case '/setphrase':
                    return await setPhraseCommand(message, args);

                case '/setpin':
                    return await setPinPatternCommand(message, args);

                case '/clearpin':
                    return await clearPinPatternCommand(message, args);

                case '/report':
                    return await reportCommand(message, args);

                case '/reportx':
                    return await reportOverlapCommand(message, args);

                case '/reportlive':
                    return await reportLiveCommand(message, args);

                case '/setgroup':
                    return await setGroupCommand(message, args);

                case '/buttons':
                    return await buttonsCommand(message, args);

                case '/post':
                    return await postCommand(message, args);

                case '/cancel':
                    await clearButtonsPending();

                    return await api.sendMessage({
                        chat_id: chatId,
                        text: 'Cancelled.',
                    });

                case '/debug':
                    return await debugCommand(message, true);

                case '/nodebug':
                    return await debugCommand(message, false);

                case '/reset':
                    return await resetCommand(message, args);

                case '/migrate':
                    return await migrateCommand(message);

                default:
                    return await echo(
                        chatId,
                        'owner: unknown command',
                        command,
                    );
            }
        }

        if (pending) {
            return await handlePendingStep(message, pending);
        }

        return await echo(chatId, 'owner: ignored (no pending action)');
    } catch (e) {
        await echo(
            chatId,
            `owner: CRASH in ${command}`,
            e?.stack ?? String(e),
            true,
        );

        throw e;
    }
}

async function sendHelp(message) {
    await echo(message.chat.id, 'owner: sendHelp');

    await api.sendMessage({
        chat_id: message.chat.id,
        text:
            'Channel manager (multi-channel).\n\n' +
            'Add me to a channel as admin and it shows up in /status ' +
            'automatically. Link a discussion group with /setgroup.\n\n' +
            'Per channel:\n' +
            '• /setgroup [channel] — run inside the discussion group\n' +
            '• /setphrase [channel] <phrase> — required phrase in the group\n' +
            '• /setpin [channel] <pattern> — pin posts containing it\n' +
            '• /clearpin [channel] — stop pinning matching posts\n' +
            '• /report <channel|all> [hours|today] — member stats\n' +
            '• /reportx <channel a> <channel b> — shared members\n' +
            '• /reportlive <a> <b> [limit] [offset] — check each member via API\n' +
            '• /buttons [channel] [on|off|set|show|clear]\n' +
            '• /post [link] — attach buttons to one post\n' +
            '• /reset [channel] — clear group/phrase/pin/buttons\n\n' +
            'Other: /status [channel], /migrate, /cancel, /debug, /nodebug\n\n' +
            'A channel can be given as @username or its numeric chat id. ' +
            'If only one channel exists it can be omitted.',
    });
}

async function sendStatus(message, args) {
    await echo(message.chat.id, 'owner: sendStatus', args);

    const all = await listChannels();

    if (!all.length) {
        return await api.sendMessage({
            chat_id: message.chat.id,
            text:
                'No channels registered yet.\n' +
                'Add me to a channel as admin and post something there.',
        });
    }

    const ref = args.join(' ').trim();

    if (ref) {
        const channel = await findChannel(ref);

        if (!channel) {
            return await channelHelp(message, `Unknown channel: ${ref}`);
        }

        return await sendChannelDetail(message, channel);
    }

    const lines = [];

    for (const channel of all) {
        const present = await countPresent(channel.channel_chat_id);
        const buttons = Array.isArray(channel.buttons)
            ? channel.buttons.length
            : 0;

        lines.push(
            `${channel.active === false ? '⏸' : '●'} ${channelLabel(channel)}`,
            `   group: ${channel.group_chat_id ?? 'not set'} · ` +
                `phrase: ${channel.phrase ? 'set' : 'not set'} · ` +
                `pin: ${channel.pin_pattern ? 'set' : 'not set'} · ` +
                `buttons: ${channel.buttons_enabled ? 'ON' : 'OFF'} (${buttons}) · ` +
                `tracked members: ${present}`,
        );
    }

    lines.push('', 'Details: /status <@username|chat id>');

    return await sendLines(message.chat.id, [
        `Channels (${all.length}):`,
        '',
        ...lines,
    ]);
}

async function sendChannelDetail(message, channel) {
    const present = await countPresent(channel.channel_chat_id);
    const buttons = Array.isArray(channel.buttons) ? channel.buttons : [];

    const lines = [
        `${channel.active === false ? '⏸ inactive' : '● active'}`,
        `Channel: ${channelTitle(channel)}`,
        `Chat id: ${channel.channel_chat_id}`,
        `Group chat: ${channel.group_chat_id ?? 'not set'}`,
        `Phrase: ${channel.phrase ?? 'not set'}`,
        `Pin pattern: ${channel.pin_pattern ?? 'not set'}`,
        `Buttons: ${channel.buttons_enabled ? 'ON' : 'OFF'} ` +
            `(${buttons.length} defined)`,
        `Tracked members: ${present}`,
    ];

    if (buttons.length) {
        lines.push('', formatButtons(buttons));
    }

    return await api.sendMessage({
        chat_id: message.chat.id,
        text: lines.join('\n'),
    });
}

async function channelHelp(message, prefix) {
    const all = await listChannels();

    const lines = all.length
        ? all.map((c) => `• ${channelLabel(c)}`)
        : ['• (no channels registered)'];

    return await api.sendMessage({
        chat_id: message.chat.id,
        text:
            `${prefix}\n\n` +
            'Give a channel as @username or its numeric chat id:\n' +
            lines.join('\n'),
    });
}

const BUTTONS_HELP =
    'Channel post buttons (per channel).\n\n' +
    BUTTON_SYNTAX_HINT +
    '\n\nCommands:\n' +
    '/buttons <channel> set — define buttons for that channel\n' +
    '/buttons <channel> on — apply them to every new channel post\n' +
    '/buttons <channel> off — stop applying them\n' +
    '/buttons <channel> show — show the current buttons\n' +
    '/buttons <channel> clear — remove the buttons\n' +
    '/post — attach buttons to one specific post ' +
    '(forward the post or send its t.me link)\n' +
    '/cancel — abort the current step\n\n' +
    'The channel can be omitted when only one exists.';

function parseButtonArgs(args) {
    const first = (args[0] ?? '').toLowerCase();

    if (BUTTON_SUBS.has(first)) {
        return {
            sub: first,
            ref: args.slice(1).join(' ').trim() || null,
        };
    }

    return {
        ref: args[0] ?? null,
        sub: (args[1] ?? 'show').toLowerCase(),
    };
}

async function buttonsCommand(message, args) {
    const chatId = message.chat.id;
    const { sub, ref } = parseButtonArgs(args);

    await echo(chatId, 'owner: buttonsCommand', { sub, ref });

    if (sub === 'help') {
        return await api.sendMessage({ chat_id: chatId, text: BUTTONS_HELP });
    }

    if (!BUTTON_SUBS.has(sub)) {
        return await api.sendMessage({
            chat_id: chatId,
            text: `Unknown /buttons option: ${sub}\n\n${BUTTONS_HELP}`,
        });
    }

    const channel = await resolveChannel(message, ref);

    if (!channel) {
        if (sub === 'show' && !ref) {
            return await showAllButtons(message);
        }

        return await channelHelp(
            message,
            'Which channel? Example: /buttons @mychannel ' + sub,
        );
    }

    switch (sub) {
        case 'on': {
            await setGlobalButtonsEnabled(true, channel.channel_chat_id);
            await clearButtonsPending();

            return await api.sendMessage({
                chat_id: chatId,
                text:
                    `Buttons: ON for ${channelLabel(channel)}. ` +
                    'New channel posts will get these buttons.',
            });
        }

        case 'off': {
            await setGlobalButtonsEnabled(false, channel.channel_chat_id);
            await clearButtonsPending();

            return await api.sendMessage({
                chat_id: chatId,
                text: `Buttons: OFF for ${channelLabel(channel)}.`,
            });
        }

        case 'set': {
            await startGlobalButtonsFlow(channel.channel_chat_id);

            return await api.sendMessage({
                chat_id: chatId,
                text:
                    `Send the default buttons for ${channelLabel(channel)} now.\n\n` +
                    BUTTON_SYNTAX_HINT,
            });
        }

        case 'clear': {
            await setButtons(channel.channel_chat_id, []);
            await setGlobalButtonsEnabled(false, channel.channel_chat_id);
            await clearButtonsPending();

            return await api.sendMessage({
                chat_id: chatId,
                text: `Buttons cleared for ${channelLabel(channel)}.`,
            });
        }

        case 'show':
        default:
            return await showButtons(message, channel);
    }
}

async function showAllButtons(message) {
    const all = await listChannels();
    const lines = [`Buttons by channel:`];

    for (const channel of all) {
        const buttons = Array.isArray(channel.buttons)
            ? channel.buttons.length
            : 0;

        lines.push(
            `• ${channelLabel(channel)}: ` +
                `${channel.buttons_enabled ? 'ON' : 'OFF'} (${buttons})`,
        );
    }

    return await api.sendMessage({
        chat_id: message.chat.id,
        text: lines.join('\n'),
    });
}

async function showButtons(message, channel) {
    const fresh = await getChannelByChatId(channel.channel_chat_id);
    const enabled = fresh?.buttons_enabled === true;
    const buttons = Array.isArray(fresh?.buttons) ? fresh.buttons : [];

    const payload = {
        chat_id: message.chat.id,
        text:
            `Buttons: ${enabled ? 'ON' : 'OFF'}\n` +
            `Channel: ${channelLabel(fresh ?? channel)}\n\n` +
            (buttons.length
                ? buttons.length + ' defined'
                : 'No default buttons defined.'),
    };

    if (buttons.length) {
        payload.reply_markup = buildKeyboard(buttons);
    }

    return await api.sendMessage(payload);
}

async function postCommand(message, args) {
    const chatId = message.chat.id;
    const link = args.join(' ').trim();

    await echo(chatId, 'owner: postCommand', { link });

    let target = null;

    if (link) {
        target = targetFromLink(link);

        if (!target) {
            return await api.sendMessage({
                chat_id: chatId,
                text:
                    'Could not parse that link.\n' +
                    'Send a post link like https://t.me/PersianSarcasm/123 ' +
                    'or https://t.me/c/1234567890/123',
            });
        }
    } else if (message.reply_to_message) {
        target = targetFromForward(message.reply_to_message);
    }

    const channel = target
        ? await channelForTarget(target)
        : await resolveChannel(message, null);

    await startPostFlow(target, channel?.channel_chat_id ?? null);

    if (target) {
        return await api.sendMessage({
            chat_id: chatId,
            text:
                `Target: ${formatTarget(target)}\n\n` +
                `Send the buttons now.\n\n${BUTTON_SYNTAX_HINT}`,
        });
    }

    return await api.sendMessage({
        chat_id: chatId,
        text:
            'Forward the channel post to me, or send its t.me link ' +
            '(or /cancel).',
    });
}

async function channelForTarget(target) {
    if (!target?.chat_id) {
        return null;
    }

    if (typeof target.chat_id === 'number') {
        return await getChannelByChatId(target.chat_id);
    }

    return await findChannel(target.chat_id);
}

async function handlePendingStep(message, pending) {
    const chatId = message.chat.id;

    await echo(chatId, 'owner: pending step', {
        action: pending.action,
        step: pending.step,
        channel_chat_id: pending.channel_chat_id,
    });

    if (pending.step === 'target') {
        const target =
            targetFromForward(message) ??
            targetFromLink(message.text ?? message.caption ?? '');

        if (!target) {
            return await api.sendMessage({
                chat_id: chatId,
                text:
                    'That is not a forwarded channel post or a valid ' +
                    't.me link. Send the post again, or /cancel.',
            });
        }

        const channel =
            (await channelForTarget(target)) ??
            (await resolveChannel(message, null));

        await startPostFlow(target, channel?.channel_chat_id ?? null);

        return await api.sendMessage({
            chat_id: chatId,
            text:
                `Target: ${formatTarget(target)}\n\n` +
                `Send the buttons now.\n\n${BUTTON_SYNTAX_HINT}`,
        });
    }

    if (pending.action === 'global') {
        return await finishGlobalButtons(message, pending);
    }

    return await finishPostButtons(message, pending);
}

async function finishGlobalButtons(message, pending) {
    const chatId = message.chat.id;

    const channel = pending.channel_chat_id
        ? await getChannelByChatId(pending.channel_chat_id)
        : await resolveChannel(message, null);

    if (!channel) {
        await clearButtonsPending();

        return await channelHelp(
            message,
            'Could not tell which channel these buttons are for.',
        );
    }

    let buttons;

    try {
        buttons = await saveGlobalButtons(
            message.text ?? '',
            channel.channel_chat_id,
        );
    } catch (e) {
        return await api.sendMessage({
            chat_id: chatId,
            text: `Could not parse the buttons:\n${e?.message ?? String(e)}\n\nSend them again, or /cancel.`,
        });
    }

    const fresh = await getChannelByChatId(channel.channel_chat_id);

    return await api.sendMessage({
        chat_id: chatId,
        text:
            `Default buttons saved for ${channelLabel(channel)} ` +
            `(${buttons.length}).` +
            (fresh?.buttons_enabled
                ? '\nThey apply to new channel posts.'
                : '\nSend /buttons ' +
                  `${channel.username ? '@' + channel.username : channel.channel_chat_id}` +
                  ' on to apply them to new channel posts.'),
        reply_markup: buildKeyboard(buttons),
    });
}

async function finishPostButtons(message, pending) {
    const chatId = message.chat.id;
    const target = pending.target;

    if (!target) {
        await clearButtonsPending();

        return await api.sendMessage({
            chat_id: chatId,
            text: 'No target set. Start again with /post.',
        });
    }

    let buttons;

    try {
        buttons = parseButtons(message.text ?? '');
    } catch (e) {
        return await api.sendMessage({
            chat_id: chatId,
            text: `Could not parse the buttons:\n${e?.message ?? String(e)}\n\nSend them again, or /cancel.`,
        });
    }

    try {
        await applyButtons(target.chat_id, target.message_id, buttons);
    } catch (e) {
        await echo(chatId, 'owner: apply buttons failed', {
            code: e?.code,
            description: e?.description,
        });
        await clearButtonsPending();

        return await api.sendMessage({
            chat_id: chatId,
            text:
                `Failed to edit the post: ` +
                `${e?.description ?? e?.message ?? String(e)}\n\n` +
                'Make sure I am an admin in the channel with the ' +
                "'Edit Messages of Others' permission.",
        });
    }

    await clearButtonsPending();

    return await api.sendMessage({
        chat_id: chatId,
        text:
            `Buttons applied to ${formatTarget(target)}.\n\n` +
            formatButtons(buttons),
    });
}

async function setPhraseCommand(message, args) {
    if (!args.length) {
        return await api.sendMessage({
            chat_id: message.chat.id,
            text: 'Usage: /setphrase [channel] <phrase>',
        });
    }

    let ref = null;
    let phraseArgs = args;

    if (isChannelRefToken(args[0])) {
        ref = args[0];
        phraseArgs = args.slice(1);
    }

    const phrase = phraseArgs.join(' ').trim();
    const channel = await resolveChannel(message, ref);

    await echo(message.chat.id, 'owner: setPhraseCommand', { ref, phrase });

    if (!channel) {
        return await channelHelp(
            message,
            'Which channel? Example: /setphrase @mychannel required phrase',
        );
    }

    if (!phrase) {
        return await api.sendMessage({
            chat_id: message.chat.id,
            text: 'Usage: /setphrase [channel] <phrase>',
        });
    }

    await setPhrase(channel.channel_chat_id, phrase);

    await echo(message.chat.id, 'owner: phrase saved');

    await api.sendMessage({
        chat_id: message.chat.id,
        text: `Phrase set for ${channelLabel(channel)}:\n${phrase}`,
    });
}

async function setPinPatternCommand(message, args) {
    const chatId = message.chat.id;

    if (!args.length) {
        return await api.sendMessage({
            chat_id: chatId,
            text:
                'Usage: /setpin [channel] <pattern>\n' +
                'New channel posts whose text or caption contains the ' +
                'pattern are pinned.',
        });
    }

    let ref = null;
    let patternArgs = args;

    if (isChannelRefToken(args[0])) {
        ref = args[0];
        patternArgs = args.slice(1);
    }

    const pattern = patternArgs.join(' ').trim();
    const channel = await resolveChannel(message, ref);

    await echo(chatId, 'owner: setPinPatternCommand', { ref, pattern });

    if (!channel) {
        return await channelHelp(
            message,
            'Which channel? Example: /setpin @mychannel #pinned',
        );
    }

    if (!pattern) {
        return await api.sendMessage({
            chat_id: chatId,
            text: 'Usage: /setpin [channel] <pattern>',
        });
    }

    await setPinPattern(channel.channel_chat_id, pattern);

    return await api.sendMessage({
        chat_id: chatId,
        text:
            `Pin pattern set for ${channelLabel(channel)}:\n${pattern}\n\n` +
            'New posts containing this text will be pinned silently. ' +
            'I need the "Pin Messages" admin permission in the channel.',
    });
}

async function clearPinPatternCommand(message, args) {
    const chatId = message.chat.id;
    const ref = args.join(' ').trim() || null;
    const channel = await resolveChannel(message, ref);

    await echo(chatId, 'owner: clearPinPatternCommand', { ref });

    if (!channel) {
        return await channelHelp(
            message,
            'Which channel? Example: /clearpin @mychannel',
        );
    }

    await setPinPattern(channel.channel_chat_id, null);

    return await api.sendMessage({
        chat_id: chatId,
        text: `Pin pattern cleared for ${channelLabel(channel)}.`,
    });
}

function isChannelRefToken(token) {
    return /^@[A-Za-z0-9_]+$/.test(token) || /^-\d+$/.test(token);
}

function isPeriodArg(token) {
    if (String(token).toLowerCase() === 'today') {
        return true;
    }

    const hours = Number(token);

    return Number.isFinite(hours) && hours > 0;
}

function periodFrom(token) {
    if (String(token).toLowerCase() === 'today') {
        return { start: startOfToday(), label: 'today' };
    }

    const hours = Number(token);

    if (!Number.isFinite(hours) || hours <= 0) {
        return null;
    }

    return {
        start: new Date(Date.now() - hours * 60 * 60 * 1000),
        label: `last ${hours}h`,
    };
}

async function reportCommand(message, args) {
    await echo(message.chat.id, 'owner: reportCommand', { args }, true);

    let ref = null;
    let periodToken = null;
    let channelArgs = args;

    if (args.length) {
        const last = args[args.length - 1];

        if (isPeriodArg(last) && !(args.length === 1 && isChannelRefToken(last))) {
            periodToken = last;
            channelArgs = args.slice(0, -1);
        }
    }

    const period = periodFrom(periodToken ?? 'today');

    if (!period) {
        return await api.sendMessage({
            chat_id: message.chat.id,
            text:
                'Usage: /report <channel|all> [hours|today]\n' +
                'Examples: /report @mychannel 24, /report all today, ' +
                '/report 24',
        });
    }

    if (channelArgs.length) {
        ref = channelArgs.join(' ').trim();
    }

    if (ref && ref.toLowerCase() === 'all') {
        return await reportAll(message, period);
    }

    const channel = await resolveChannel(message, ref);

    if (!channel) {
        return await channelHelp(
            message,
            'Which channel? Example: /report @mychannel 24',
        );
    }

    let r;

    try {
        r = await buildReport({
            start: period.start,
            label: period.label,
            chatId: channel.channel_chat_id,
        });
    } catch (e) {
        await echo(message.chat.id, 'owner: report FAILED', e?.stack ?? String(e), true);

        return await api.sendMessage({
            chat_id: message.chat.id,
            text: `Report failed:\n${e?.description ?? e?.message ?? String(e)}`,
        });
    }

    await echo(message.chat.id, 'owner: report', r, true);

    return await api.sendMessage({
        chat_id: message.chat.id,
        text: formatReport(channel, r).join('\n'),
    });
}

async function reportAll(message, period) {
    const all = await listChannels();

    if (!all.length) {
        return await channelHelp(message, 'No channels registered yet.');
    }

    const lines = [
        `Member report — ${period.label} (all channels)`,
        `Since: ${period.start.toISOString()}`,
        '',
    ];

    let totalJoined = 0;
    let totalLeft = 0;

    for (const channel of all) {
        const r = await buildReport({
            start: period.start,
            label: period.label,
            chatId: channel.channel_chat_id,
        });

        totalJoined += r.joined;
        totalLeft += r.left;

        const net = `${r.net >= 0 ? '+' : ''}${r.net}`;

        lines.push(
            `${channel.active === false ? '⏸' : '●'} ${channelLabel(channel)}: ` +
                `joined ${r.joined}, left ${r.left}, net ${net}`,
        );
    }

    const net = totalJoined - totalLeft;

    lines.push(
        '',
        `Total: joined ${totalJoined}, left ${totalLeft}, ` +
            `net ${net >= 0 ? '+' : ''}${net}`,
    );

    return await sendLines(message.chat.id, lines);
}

async function reportOverlapCommand(message, args) {
    const chatId = message.chat.id;
    const refs = args.filter(Boolean);

    await echo(chatId, 'owner: reportOverlapCommand', { args }, true);

    if (refs.length !== 2) {
        return await channelHelp(
            message,
            'Usage: /reportx <channel a> <channel b>\n' +
                'Example: /reportx @persiansarcasm @otherchannel',
        );
    }

    const [refA, refB] = refs;
    const channelA = await findChannel(refA);

    if (!channelA) {
        return await channelHelp(message, `Unknown channel: ${refA}`);
    }

    const channelB = await findChannel(refB);

    if (!channelB) {
        return await channelHelp(message, `Unknown channel: ${refB}`);
    }

    let total;
    let shared;

    try {
        total = await countPresent(channelA.channel_chat_id);
        shared = await countSharedPresent(
            channelA.channel_chat_id,
            channelB.channel_chat_id,
        );
    } catch (e) {
        await echo(chatId, 'owner: reportx FAILED', e?.stack ?? String(e), true);

        return await api.sendMessage({
            chat_id: chatId,
            text: `Overlap report failed:\n${e?.description ?? e?.message ?? String(e)}`,
        });
    }

    const pct = total > 0 ? ((shared / total) * 100).toFixed(1) : '0.0';

    await echo(chatId, 'owner: reportx', {
        a: channelA.channel_chat_id,
        b: channelB.channel_chat_id,
        total,
        shared,
    }, true);

    return await api.sendMessage({
        chat_id: chatId,
        text:
            `Out of ${total} members of ${describeChannel(channelA)}, ` +
            `${shared} are also a member of ${describeChannel(channelB)} ` +
            `(${pct}%).\n\n` +
            (total > 0
                ? 'Based on members tracked by the bot ' +
                  '(joins and leaves it has seen).'
                : `No join events have been tracked for ` +
                  `${describeChannel(channelA)} yet, so the overlap is unknown.`),
    });
}

function describeChannel(channel) {
    const ref = channelRef(channel);

    return channel?.title ? `${ref} (${channel.title})` : ref;
}

const LIVE_REPORT_USAGE =
    'Usage: /reportlive <channel a> <channel b> [limit] [offset]\n' +
    `Example: /reportlive @persiansarcasm @otherchannel ${LIVE_CHECK_DEFAULT_LIMIT}\n\n` +
    'Checks tracked members of channel a one by one against channel b ' +
    `through the Telegram API (newest first, up to ${LIVE_CHECK_MAX_LIMIT}). ` +
    'The bot must be an admin in both channels.';

function parseCountToken(token, { allowZero = false } = {}) {
    const raw = String(token ?? '').trim();

    if (!/^\d+$/.test(raw)) {
        return NaN;
    }

    const n = Number(raw);

    if (!Number.isSafeInteger(n)) {
        return NaN;
    }

    if (!allowZero && n < 1) {
        return NaN;
    }

    return n;
}

async function reportLiveCommand(message, args) {
    const chatId = message.chat.id;
    const tokens = args.filter(Boolean);

    await echo(chatId, 'owner: reportLiveCommand', { args }, true);

    if (tokens.length < 2 || tokens.length > 4) {
        return await channelHelp(message, LIVE_REPORT_USAGE);
    }

    const [refA, refB, limitToken, offsetToken] = tokens;

    const limit =
        limitToken == null
            ? LIVE_CHECK_DEFAULT_LIMIT
            : parseCountToken(limitToken);
    const offset =
        offsetToken == null ? 0 : parseCountToken(offsetToken, { allowZero: true });

    if (!Number.isFinite(limit) || !Number.isFinite(offset)) {
        return await api.sendMessage({
            chat_id: chatId,
            text: `Invalid limit or offset.\n\n${LIVE_REPORT_USAGE}`,
        });
    }

    const cappedLimit = Math.min(limit, LIVE_CHECK_MAX_LIMIT);

    const channelA = await findChannel(refA);

    if (!channelA) {
        return await channelHelp(message, `Unknown channel: ${refA}`);
    }

    const channelB = await findChannel(refB);

    if (!channelB) {
        return await channelHelp(message, `Unknown channel: ${refB}`);
    }

    let r;

    try {
        r = await liveSharedReport({
            sourceChatId: channelA.channel_chat_id,
            targetChatId: channelB.channel_chat_id,
            limit: cappedLimit,
            offset,
        });
    } catch (e) {
        await echo(chatId, 'owner: reportlive FAILED', e?.stack ?? String(e), true);

        return await api.sendMessage({
            chat_id: chatId,
            text: `Live overlap check failed:\n${e?.description ?? e?.message ?? String(e)}`,
        });
    }

    await echo(chatId, 'owner: reportlive', r, true);

    return await api.sendMessage({
        chat_id: chatId,
        text: formatLiveReport(r, { channelA, channelB, refA, refB, limit, cappedLimit }),
    });
}

function formatLiveReport(r, { channelA, channelB, refA, refB, limit, cappedLimit }) {
    const a = describeChannel(channelA);
    const b = describeChannel(channelB);
    const pct = r.checked > 0 ? ((r.present / r.checked) * 100).toFixed(1) : '0.0';
    const lines = [];

    if (r.requested === 0) {
        return [
            r.totalTracked === 0
                ? `No tracked members for ${a} yet, so there is nothing to check.`
                : `No tracked members at offset ${r.offset} ` +
                  `(${r.totalTracked} tracked in total).`,
            '',
            'Only members tracked by the bot (joins it has seen) can be checked.',
        ].join('\n');
    }

    if (r.checked === 0) {
        lines.push(`Could not check any members of ${a} against ${b}.`);

        if (r.firstError) {
            const code = r.firstError.code ? `${r.firstError.code}: ` : '';
            lines.push(`Telegram said: ${code}${r.firstError.description}`);
        }

        lines.push(
            '',
            'Make sure the bot is an admin in both channels, then try again.',
        );

        return lines.join('\n');
    }

    lines.push(
        `Out of ${r.checked} members of ${a} checked via Telegram, ` +
            `${r.present} are also a member of ${b} (${pct}%).`,
        '',
        `tracked members of ${channelRef(channelA)}: ${r.totalTracked}`,
        `checked: ${r.checked} (not a member: ${r.absent}, ` +
            `could not check: ${r.failed})`,
    );

    if (r.totalTracked > 0) {
        const from = r.offset + 1;
        const to = r.offset + r.processed;

        lines.push(`positions in tracked list: ${from}–${to}`);
    }

    if (limit > cappedLimit) {
        lines.push(`limit capped at ${cappedLimit}`);
    }

    const notes = [];

    if (r.timedOut) {
        notes.push('stopped early: the time budget for one run ran out');
    }

    if (r.rateLimited) {
        notes.push(
            'Telegram rate-limited the check' +
                (r.retryAfter ? `; retry after ${r.retryAfter}s` : ''),
        );
    }

    if (r.failed > 0 && !r.rateLimited && r.firstError) {
        const code = r.firstError.code ? `${r.firstError.code}: ` : '';
        notes.push(`first check error — ${code}${r.firstError.description}`);
    }

    if (notes.length) {
        lines.push('', ...notes.map((note) => `• ${note}`));
    }

    if (r.remainingTracked > 0 && r.processed > 0) {
        const nextOffset = r.offset + r.processed;

        lines.push(
            '',
            `Remaining tracked members: ${r.remainingTracked}.`,
            `Continue with: /reportlive ${refA} ${refB} ${cappedLimit} ${nextOffset}`,
        );
    }

    lines.push(
        '',
        'Only members tracked by the bot (joins it has seen) can be checked.',
    );

    return lines.join('\n');
}

function formatReport(channel, r) {
    const net = `${r.net >= 0 ? '+' : ''}${r.net}`;
    const lines = [
        `Channel: ${channelLabel(channel)}`,
        `Member report — ${r.label}`,
        `Since: ${r.start.toISOString()}`,
        '',
        `Joined: ${r.joined}`,
        `  from invite link: ${r.joinedInvite.total}`,
        `    stayed: ${r.joinedInvite.stayed}`,
        `    left again: ${r.joinedInvite.leftAgain}`,
    ];

    for (const link of r.joinedInvite.byLink) {
        lines.push(
            `    "${link.link}": ${link.total} ` +
            `(stayed ${link.stayed}, left ${link.leftAgain})`,
        );
    }

    lines.push(
        `  not from invite link: ${r.joinedOther.total}`,
        `    stayed: ${r.joinedOther.stayed}`,
        `    left again: ${r.joinedOther.leftAgain}`,
        '',
        `Left: ${r.left}`,
        `  joined & left in period: ${r.leftJoinedAndLeft}`,
        `  joined earlier (tracked): ${r.leftTrackedBefore}`,
        `    from invite link: ${r.leftTrackedBeforeInvite}`,
    );

    for (const link of r.leftTrackedBeforeByLink) {
        lines.push(`      "${link.link}": ${link.count}`);
    }

    lines.push(
        `    without an invite link: ${r.leftTrackedBeforeOther}`,
        `  no join info (pre-existing): ${r.leftNoInfo}`,
        '',
        `Net: ${net}`,
    );

    return lines;
}

async function sendLines(chatId, lines) {
    const chunks = [];
    let current = '';

    for (const line of lines) {
        if (current && current.length + line.length + 1 > 3800) {
            chunks.push(current);
            current = '';
        }

        current += (current ? '\n' : '') + line;
    }

    if (current) {
        chunks.push(current);
    }

    for (const chunk of chunks) {
        await api.sendMessage({ chat_id: chatId, text: chunk });
    }
}

async function setGroupCommand(message, args) {
    const chat = message.chat;
    const ref = args.join(' ').trim() || null;

    await echo(chat.id, 'owner: setGroupCommand', {
        chat_type: chat.type,
        title: chat.title,
        ref,
    });

    if (chat.type !== 'group' && chat.type !== 'supergroup') {
        return await api.sendMessage({
            chat_id: chat.id,
            text: 'Send /setgroup inside the discussion group.',
        });
    }

    const me = await api.getMe();
    await echo(chat.id, 'owner: getMe', me);

    const member = await api.getChatMember({
        chat_id: chat.id,
        user_id: me.id,
    });
    await echo(chat.id, 'owner: bot membership', member);

    if (member.status !== 'administrator' && member.status !== 'creator') {
        return await api.sendMessage({
            chat_id: chat.id,
            text:
                'Make me an admin with the Delete Messages permission first.',
        });
    }

    let channel = ref ? await findChannel(ref) : null;

    if (!channel) {
        const linkedId = await linkedChannelId(chat.id);

        if (linkedId != null) {
            channel = await getChannelByChatId(linkedId);

            if (!channel) {
                try {
                    const linked = await api.getChat({ chat_id: linkedId });
                    channel = await registerChannel(linked);
                } catch (e) {
                    await echo(chat.id, 'owner: getChat linked failed', {
                        code: e?.code,
                        description: e?.description,
                    });
                }
            }
        }
    }

    if (!channel) {
        return await api.sendMessage({
            chat_id: chat.id,
            text:
                'Could not find the channel for this group.\n' +
                'Link a channel to this group, or send ' +
                '/setgroup @channel (or its chat id).',
        });
    }

    await setGroupChatId(channel.channel_chat_id, chat.id);

    await echo(chat.id, 'owner: group saved', {
        channel: channel.channel_chat_id,
        group: chat.id,
    });

    await api.sendMessage({
        chat_id: chat.id,
        text:
            `Group set for ${channelLabel(channel)}:\n` +
            `${chat.title}\n${chat.id}`,
    });
}

async function resetCommand(message, args) {
    const ref = args.join(' ').trim() || null;
    const channel = await resolveChannel(message, ref);

    await echo(message.chat.id, 'owner: resetCommand', { ref });

    if (!channel) {
        return await channelHelp(
            message,
            'Which channel? Example: /reset @mychannel',
        );
    }

    await resetChannel(channel.channel_chat_id);

    await api.sendMessage({
        chat_id: message.chat.id,
        text:
            `Cleared group, phrase, pin pattern and buttons for ` +
            `${channelLabel(channel)}.`,
    });
}

async function migrateCommand(message) {
    await echo(message.chat.id, 'owner: migrateCommand');

    // Ensures the legacy settings row is copied into `channels` first.
    const all = await listChannels();
    const result = await migrateLegacyMembers();

    await echo(message.chat.id, 'owner: migrate result', {
        ...result,
        channels: all.length,
    });

    await api.sendMessage({
        chat_id: message.chat.id,
        text:
            'Legacy data migration finished.\n\n' +
            `Channels: ${all.length}\n` +
            `Legacy member rows: ${result.legacy}\n` +
            `Rows in channel_members: ${result.total}\n\n` +
            'This is safe to run again; existing rows are kept.',
    });
}

async function debugCommand(message, enabled) {
    await setDebug(enabled);

    await api.sendMessage({
        chat_id: message.chat.id,
        text: enabled ? 'Debug messages: ON' : 'Debug messages: OFF',
    });

    await echo(message.chat.id, enabled ? 'owner: debug ON' : 'owner: debug OFF');
}
