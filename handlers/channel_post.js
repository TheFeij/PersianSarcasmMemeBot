import { echo } from 'lib/debug';
import { handleNewChannelPost } from 'lib/buttons';

export default async function (post, ctx) {
    try {
        await handleNewChannelPost(post);
    } catch (e) {
        await echo(
            post?.chat?.id,
            'handler/channel_post: CRASH',
            e?.stack ?? String(e),
        );

        throw e;
    }
}
