// Type only the methods we actually use (most robust for production builds)
export type TelegramBotLike = {
  sendMessage: (
    chatId: number,
    text: string,
    options?: any
  ) => Promise<any>;
};

function chunkString(str: string, maxLen: number): string[] {
  if (str.length <= maxLen) return [str];
  const chunks: string[] = [];
  let i = 0;

  while (i < str.length) {
    let end = Math.min(i + maxLen, str.length);
    const slice = str.slice(i, end);
    const lastNewline = slice.lastIndexOf("\n");
    if (lastNewline > Math.floor(maxLen * 0.6)) end = i + lastNewline + 1;
    chunks.push(str.slice(i, end));
    i = end;
  }
  return chunks;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function sendTelegramMessageSafe(
  bot: TelegramBotLike,
  chatId: number,
  text: string
) {
  const MAX = 3800;
  const chunks = chunkString(text, MAX);

  for (let idx = 0; idx < chunks.length; idx++) {
    const part = chunks[idx];
    try {
      await bot.sendMessage(chatId, part, { disable_web_page_preview: true });
    } catch (err: any) {
      const body = err?.response?.body;
      const retryAfter = body?.parameters?.retry_after ?? body?.parameters?.retry_after_seconds;
      if (typeof retryAfter === "number" && retryAfter > 0) {
        await sleep(retryAfter * 1000);
        await bot.sendMessage(chatId, part, { disable_web_page_preview: true });
      } else {
        throw err;
      }
    }
    if (chunks.length > 1) await sleep(80);
  }
}
