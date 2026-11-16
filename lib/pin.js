import { api } from 'sdk';
import { echo } from 'lib/debug';
import { getChannelByChatId } from 'lib/channels';

// Pins a new channel post when its text or caption contains the channel's
// configured pin pattern. Pinning silently (no notification to subscribers) is
// the conservative default; the bot needs the "Pin Messages" permission.
export async function handleChannelPostPin(post) {
    const chatId = post?.chat?.id;

    if (chatId == null) {
        return;
    }

    const channel = await getChannelByChatId(chatId);

    if (!channel?.pin_pattern) {
        return;
    }

    const content = post.text ?? post.caption ?? '';

    if (!content.includes(channel.pin_pattern)) {
        return;
    }

    await echo(chatId, 'pin: pattern matched', {
        message_id: post.message_id,
        pattern: channel.pin_pattern,
    });

    try {
        await api.pinChatMessage({
            chat_id: chatId,
            message_id: post.message_id,
            disable_notification: true,
        });

        await echo(chatId, 'pin: pinned', post.message_id);
    } catch (e) {
        await echo(chatId, 'pin: pin failed', {
            code: e?.code,
            description: e?.description,
            message: e?.message,
        });
    }
}
