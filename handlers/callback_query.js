import { api } from 'sdk';
import { echo } from 'lib/debug';
import { handleAdCallback } from 'lib/ads';

export default async function (query, ctx) {
    try {
        const handled = await handleAdCallback(query);

        if (!handled) {
            try {
                await api.answerCallbackQuery({
                    callback_query_id: query.id,
                    text: 'Unknown action.',
                });
            } catch (e) {
                console.error(
                    '[callback_query] answer failed:',
                    e?.description ?? e?.message ?? e,
                );
            }
        }
    } catch (e) {
        await echo(
            query?.message?.chat?.id,
            'handler/callback_query: CRASH',
            e?.stack ?? String(e),
        );

        throw e;
    }
}
