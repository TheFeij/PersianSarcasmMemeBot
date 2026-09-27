import { api } from 'sdk';
import { ownerTGID } from 'lib/config/config';
import { echo } from 'lib/debug';
import {
    getSettings,
    resetSettings,
    setDebug,
    setGroupChatId,
    setPhrase,
} from 'lib/settings';

export async function handleOwnerMessage(message) {
    const chatId = message.chat.id;

    await echo(chatId, 'owner: id check', {
        got: message.from?.id,
        expected: ownerTGID,
        match: message.from?.id === ownerTGID,
    });

    if (message.from?.id !== ownerTGID) {
        return;
    }

    const [command, ...args] = (message.text ?? '').trim().split(/\s+/);

    await echo(chatId, 'owner: command', { command, args });

    try {
        switch (command) {
            case '/start':
            case '/help':
                return await sendHelp(message);

            case '/status':
                return await sendStatus(message);

            case '/setphrase':
                return await setPhraseCommand(message, args);

            case '/setgroup':
                return await setGroupCommand(message);

            case '/debug':
                return await debugCommand(message, true);

            case '/nodebug':
                return await debugCommand(message, false);

            case '/reset':
                return await resetCommand(message);

            default:
                return await echo(chatId, 'owner: unknown command', command);
        }
    } catch (e) {
        await echo(chatId, `owner: CRASH in ${command}`, e?.stack ?? String(e));
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
            'Commands: /status, /setphrase <phrase>, /setgroup, /debug, ' +
            '/nodebug, /reset',
    });
}

async function sendStatus(message) {
    await echo(message.chat.id, 'owner: sendStatus');

    const s = await getSettings();

    await echo(message.chat.id, 'owner: settings', s);

    await api.sendMessage({
        chat_id: message.chat.id,
        text:
            `Owner: ${ownerTGID}\n` +
            `Group chat: ${s?.group_chat_id ?? 'not set'}\n` +
            `Phrase: ${s?.phrase ?? 'not set'}`,
    });
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
