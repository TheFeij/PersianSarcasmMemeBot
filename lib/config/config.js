// DEV: not a best proactive to store these plain in here, since telegram serverless currently does not have
// a mechanism to pass env variables, the best practice is to store them somewhere, like a server, and bot fetches
// them from there and stores them here. but currently this bot is small and these two const are not that secret
// it has little gain for too much effort. so we ignore them for now,

export const ownerTGID = 263879721;

export const debugChatId = -1004456142673;

// Extra admin(s) who may create and manage ads only (not the other owner
// commands). Keep the owner above in this list too if you extend it.
export const adminTGID = 8839879399;

// True for the owner and the ad admin(s): the only people the bot answers.
export function isPrivileged(tgId) {
    return tgId === ownerTGID || tgId === adminTGID;
}

// Minutes to add to UTC to get the local date used by ads and their date
// keyboard. Default: Iran, UTC+3:30.
export const adTimezoneOffsetMinutes = 210;
