import {api} from 'sdk';
import {ownerID} from "lib/config/config";


export async function customReplyKeyboard(message, ctx, args) {
    await api.sendMessage({
        chat_id: message.chat.id,
        text: 'پنل مدیریت',
        reply_markup: {
            keyboard: [
                [
                    {
                        text: '📊 آمار ربات',
                        style: 'primary',
                    },
                    {
                        text: '📢 ارسال همگانی',
                        style: 'success',
                    },
                ],
                [
                    {
                        text: '🗑 امین ریدههههههه',
                        style: 'danger',
                    },
                    {
                        text: '🛡 مدیریت محافظ',
                    },
                ],
            ],
            resize_keyboard: true,
        },
    });
}

export async function setMenu(message, ctx, args) {
    if (message.from.id !== ownerID) {
        return
    }

    await setPrivateMenu(message, ctx, args);

    await setOwnerMenu(message, ctx, args);
}

async function setPrivateMenu(message, ctx, args) {
    await api.setMyCommands({
        scope: {
            type: 'all_private_chats',
        },
        commands: [
            {
                command: '/start',
                description: 'شروع ربات',
            },
            {
                command: '/help',
                description: 'راهنما',
            },
        ],
    });

    console.log("setPrivateMenu: done")
}

async function setOwnerMenu(message, ctx, args) {
    await api.setMyCommands({
        scope: {
            type: 'chat',
            chat_id: ownerID,
        },
        commands: [
            {
                command: 'start',
                description: 'شروع ربات',
            },
            {
                command: 'help',
                description: 'راهنما',
            },
            {
                command: 'stats',
                description: 'آمار',
            },
            {
                command: 'broadcast',
                description: 'ارسال همگانی',
            },
            {
                command: 'panel',
                description: 'پنل مدیریت',
            },
        ],
    });

    console.log("setOwnerMenu: done")
}