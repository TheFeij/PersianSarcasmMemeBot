// DEV: not a best proactive to store these plain in here, since telegram serverless currently does not have
// a mechanism to pass env variables, the best practice is to store them somewhere, like a server, and bot fetches
// them from there and stores them here. but currently this bot is small and these two const are not that secret
// it has little gain for too much effort. so we ignore them for now,

export const ownerTGID = 263879721;

export const debugChatId = -1004456142673;
