import {api} from "sdk";


export async function start(message, ctx, args) {
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

