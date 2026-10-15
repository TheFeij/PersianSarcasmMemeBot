import { api } from 'sdk';
import { ownerTGID } from 'lib/config/config';
import { echo } from 'lib/debug';
import { buildReport, startOfToday } from 'lib/members';
import {
    clearButtonsPending,
    getSettings,
    resetSettings,
    setButtons,
    setDebug,
    setGroupChatId,
    setPhrase,
} from 'lib/settings';
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
                    return await sendStatus(message);

                case '/setphrase':
                    return await setPhraseCommand(message, args);

                case '/report':
                    return await reportCommand(message, args);

                case '/setgroup':
                    return await setGroupCommand(message);

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
                    return await resetCommand(message);

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
            'Channel post guard.\n\n' +
            "1. Add me to the channel's discussion group as admin " +
            'with the Delete Messages permission.\n' +
            '2. Send /setgroup inside that group.\n' +
            '3. Send /setphrase <phrase> to set the required phrase.\n\n' +
            'Every channel post in the group that does not contain the ' +
            'phrase is deleted.\n\n' +
            'Group members can reply گزارش to any message to report it ' +
            'to the debug chat, or reply ادمین to a message to send it to ' +
            'you.\n\n' +
            'Channel post buttons.\n' +
            "1. Add me to the channel as admin with the " +
            "'Edit Messages of Others' permission.\n" +
            '2. /buttons set — define the default buttons, then ' +
            '/buttons on to apply them to every new channel post.\n' +
            '3. /post — attach buttons to one specific post ' +
            '(forward the post or send its t.me link).\n\n' +
            'Commands: /status, /setphrase <phrase>, /setgroup, ' +
            '/report <hours|today>, /buttons [on|off|set|show|clear], ' +
            '/post [link], /cancel, /debug, /nodebug, /reset',
    });
}

async function sendStatus(message) {
    await echo(message.chat.id, 'owner: sendStatus');

    const s = await getSettings();

    await echo(message.chat.id, 'owner: settings', s);

    const buttonCount = Array.isArray(s?.buttons) ? s.buttons.length : 0;

    await api.sendMessage({
        chat_id: message.chat.id,
        text:
            `Owner: ${ownerTGID}\n` +
            `Group chat: ${s?.group_chat_id ?? 'not set'}\n` +
            `Channel chat: ${s?.channel_chat_id ?? 'not set'}\n` +
            `Phrase: ${s?.phrase ?? 'not set'}\n` +
            `Buttons: ${s?.buttons_enabled ? 'ON' : 'OFF'} ` +
            `(${buttonCount} defined)`,
    });
}

const BUTTONS_HELP =
    'Channel post buttons.\n\n' +
    BUTTON_SYNTAX_HINT +
    '\n\nCommands:\n' +
    '/buttons set — define the default buttons\n' +
    '/buttons on — apply default buttons to every new channel post\n' +
    '/buttons off — stop applying them\n' +
    '/buttons show — show the current default buttons\n' +
    '/buttons clear — remove the default buttons\n' +
    '/post — attach buttons to one specific post ' +
    '(forward the post or send its t.me link)\n' +
    '/cancel — abort the current step';

async function buttonsCommand(message, args) {
    const chatId = message.chat.id;
    const sub = (args[0] ?? 'show').toLowerCase();

    await echo(chatId, 'owner: buttonsCommand', { sub });

    switch (sub) {
        case 'on': {
            await setGlobalButtonsEnabled(true);
            await clearButtonsPending();

            return await api.sendMessage({
                chat_id: chatId,
                text: 'Buttons: ON. New channel posts will get the default buttons.',
            });
        }

        case 'off': {
            await setGlobalButtonsEnabled(false);
            await clearButtonsPending();

            return await api.sendMessage({
                chat_id: chatId,
                text: 'Buttons: OFF.',
            });
        }

        case 'set': {
            await startGlobalButtonsFlow();

            return await api.sendMessage({
                chat_id: chatId,
                text: `Send the default buttons now.\n\n${BUTTON_SYNTAX_HINT}`,
            });
        }

        case 'clear': {
            await setButtons([]);
            await clearButtonsPending();

            return await api.sendMessage({
                chat_id: chatId,
                text: 'Default buttons cleared.',
            });
        }

        case 'help':
            return await api.sendMessage({ chat_id: chatId, text: BUTTONS_HELP });

        case 'show':
        default:
            return await showButtons(message);
    }
}

async function showButtons(message) {
    const chatId = message.chat.id;
    const s = await getSettings();
    const enabled = s?.buttons_enabled === true;
    const buttons = Array.isArray(s?.buttons) ? s.buttons : [];

    const text =
        `Buttons: ${enabled ? 'ON' : 'OFF'}\n` +
        `Channel chat: ${s?.channel_chat_id ?? 'not set'}\n\n` +
        (buttons.length ? buttons.length + ' defined' : 'No default buttons defined.');

    const payload = { chat_id: chatId, text };

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

    await startPostFlow(target);

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

async function handlePendingStep(message, pending) {
    const chatId = message.chat.id;

    await echo(chatId, 'owner: pending step', {
        action: pending.action,
        step: pending.step,
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

        await startPostFlow(target);

        return await api.sendMessage({
            chat_id: chatId,
            text:
                `Target: ${formatTarget(target)}\n\n` +
                `Send the buttons now.\n\n${BUTTON_SYNTAX_HINT}`,
        });
    }

    if (pending.action === 'global') {
        return await finishGlobalButtons(message);
    }

    return await finishPostButtons(message, pending);
}

async function finishGlobalButtons(message) {
    const chatId = message.chat.id;

    let buttons;

    try {
        buttons = await saveGlobalButtons(message.text ?? '');
    } catch (e) {
        return await api.sendMessage({
            chat_id: chatId,
            text: `Could not parse the buttons:\n${e?.message ?? String(e)}\n\nSend them again, or /cancel.`,
        });
    }

    return await api.sendMessage({
        chat_id: chatId,
        text:
            `Default buttons saved (${buttons.length}).` +
            (await isButtonsEnabled()
                ? '\nThey apply to new channel posts.'
                : '\nSend /buttons on to apply them to new channel posts.'),
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

async function isButtonsEnabled() {
    const s = await getSettings();

    return s?.buttons_enabled === true;
}

async function setPhraseCommand(message, args) {
    const phrase = args.join(' ').trim();

    await echo(message.chat.id, 'owner: setPhraseCommand', { phrase });

    if (!phrase) {
        await api.sendMessage({
            chat_id: message.chat.id,
            text: 'Usage: /setphrase <phrase>',
        });

        return;
    }

    await setPhrase(phrase);

    await echo(message.chat.id, 'owner: phrase saved');

    await api.sendMessage({
        chat_id: message.chat.id,
        text: `Phrase set:\n${phrase}`,
    });
}

async function reportCommand(message, args) {
    const arg = (args[0] ?? '').toLowerCase();

    await echo(message.chat.id, 'owner: reportCommand', { arg }, true);

    let start;
    let label;

    if (arg === 'today') {
        start = startOfToday();
        label = 'today';
    } else {
        const hours = Number(arg);

        if (!Number.isFinite(hours) || hours <= 0) {
            await api.sendMessage({
                chat_id: message.chat.id,
                text:
                    'Usage: /report <hours|today>\n' +
                    'Examples: /report 24, /report today',
            });

            return;
        }

        start = new Date(Date.now() - hours * 60 * 60 * 1000);
        label = `last ${hours}h`;
    }

    let r;

    try {
        r = await buildReport({ start, label });
    } catch (e) {
        await echo(message.chat.id, 'owner: report FAILED', e?.stack ?? String(e), true);

        await api.sendMessage({
            chat_id: message.chat.id,
            text: `Report failed:\n${e?.description ?? e?.message ?? String(e)}`,
        });

        return;
    }

    await echo(message.chat.id, 'owner: report', r, true);

    const net = `${r.net >= 0 ? '+' : ''}${r.net}`;
    const lines = [
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
        `  no join info (pre-existing): ${r.leftNoInfo}`,
        '',
        `Net: ${net}`,
    );

    await api.sendMessage({
        chat_id: message.chat.id,
        text: lines.join('\n'),
    });
}

async function setGroupCommand(message) {
    const chat = message.chat;

    await echo(chat.id, 'owner: setGroupCommand', {
        chat_type: chat.type,
        title: chat.title,
    });

    if (chat.type !== 'group' && chat.type !== 'supergroup') {
        await api.sendMessage({
            chat_id: chat.id,
            text: 'Send /setgroup inside the discussion group.',
        });

        return;
    }

    const me = await api.getMe();
    await echo(chat.id, 'owner: getMe', me);

    const member = await api.getChatMember({
        chat_id: chat.id,
        user_id: me.id,
    });
    await echo(chat.id, 'owner: bot membership', member);

    if (member.status !== 'administrator' && member.status !== 'creator') {
        await api.sendMessage({
            chat_id: chat.id,
            text:
                'Make me an admin with the Delete Messages permission first.',
        });

        return;
    }

    await setGroupChatId(chat.id);

    await echo(chat.id, 'owner: group saved', chat.id);

    await api.sendMessage({
        chat_id: chat.id,
        text: `Group set:\n${chat.title}\n${chat.id}`,
    });
}

async function resetCommand(message) {
    await echo(message.chat.id, 'owner: resetCommand');

    await resetSettings();

    await api.sendMessage({
        chat_id: message.chat.id,
        text: 'Group and phrase cleared.',
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
