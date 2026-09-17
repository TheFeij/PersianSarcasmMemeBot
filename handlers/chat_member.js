// handlers/chat_member — runs on each `chat_member` update.
import { api } from 'sdk';

export default async function (chat_member, ctx) {
  console.log(chat_member);


  await api.sendMessage({
      chat_id: 263879721,
      text: JSON.stringify(chat_member, null, 2),
  })
}