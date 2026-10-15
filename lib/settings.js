import { db } from 'sdk';
import { settings } from 'schema';
import { eq } from 'sdk/db';

const SETTINGS_ID = 1;

export async function getSettings() {
    return await db
        .select()
        .from(settings)
        .where(eq(settings.id, SETTINGS_ID))
        .get();
}

async function patchSettings(values) {
    const existing = await getSettings();

    if (existing) {
        await db
            .update(settings)
            .set({ ...values, updated_at: new Date() })
            .where(eq(settings.id, SETTINGS_ID))
            .run();

        return;
    }

    await db
        .insert(settings)
        .values({ id: SETTINGS_ID, ...values, updated_at: new Date() })
        .run();
}

export async function setGroupChatId(chatId) {
    await patchSettings({ group_chat_id: chatId });
}

export async function setChannelChatId(chatId) {
    await patchSettings({ channel_chat_id: chatId });
}

export async function setButtonsEnabled(enabled) {
    await patchSettings({ buttons_enabled: enabled });
}

export async function setButtons(buttons) {
    await patchSettings({ buttons });
}

export async function setButtonsPending(pending) {
    await patchSettings({ buttons_pending: pending });
}

export async function clearButtonsPending() {
    await patchSettings({ buttons_pending: null });
}

export async function setPhrase(phrase) {
    await patchSettings({ phrase });
}

export async function setDebug(enabled) {
    await patchSettings({ debug: enabled });
}

export async function isDebugEnabled() {
    const s = await getSettings();

    return s?.debug === true;
}

export async function resetSettings() {
    await patchSettings({ group_chat_id: null, phrase: null });
}
