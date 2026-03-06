import { Bot, type Context } from 'grammy';
import {
  logger,
  type IrregularAdapter,
  type IrregularDispatch,
  createIrregularDispatch,
  TELEGRAM_TRADECRAFT,
} from '@bakerst/shared';
import { splitMessage } from '../util.js';

const log = logger.child({ module: 'telegram' });

const TELEGRAM_MAX_LENGTH = 4096;

export function createTelegramAdapter(
  botToken: string,
  allowedChatIds: string[],
): IrregularAdapter {
  const bot = new Bot(botToken);
  const allowedSet = new Set(allowedChatIds);
  const filterEnabled = allowedSet.size > 0;
  const platform = 'telegram';
  const tradecraft = TELEGRAM_TRADECRAFT;

  function isAllowed(chatId: number): boolean {
    if (!filterEnabled) return true;
    return allowedSet.has(String(chatId));
  }

  async function start(onDispatch: (dispatch: IrregularDispatch) => Promise<void>): Promise<void> {
    bot.on('message:text', async (ctx: Context) => {
      const msg = ctx.message!;
      const chatId = msg.chat.id;

      if (!isAllowed(chatId)) {
        log.warn({ chatId }, 'message from disallowed chat, ignoring');
        return;
      }

      const senderName = msg.from?.first_name ?? msg.from?.username ?? 'unknown';

      log.info(
        { chatId, userName: senderName, textLength: msg.text!.length },
        'received telegram message',
      );

      const dispatch = createIrregularDispatch({
        platform,
        channelId: String(chatId),
        senderId: msg.from ? String(msg.from.id) : String(chatId),
        senderName,
        text: msg.text!,
        platformMessageId: String(msg.message_id),
      });

      await onDispatch(dispatch);
    });

    bot.catch((err) => {
      log.error({ err: err.error }, 'grammy error');
    });

    // Start long polling (non-blocking)
    bot.start({
      onStart: (botInfo) => {
        log.info({ username: botInfo.username }, 'telegram bot started');
      },
    });
  }

  async function sendResponse(channelId: string, text: string, replyTo?: string): Promise<void> {
    const chunks = splitMessage(text, TELEGRAM_MAX_LENGTH);

    for (const chunk of chunks) {
      try {
        await bot.api.sendMessage(Number(channelId), chunk, {
          parse_mode: 'Markdown',
          reply_to_message_id: replyTo ? Number(replyTo) : undefined,
        });
      } catch {
        // Markdown parse failed — retry without formatting
        log.warn({ channelId }, 'markdown send failed, retrying as plain text');
        await bot.api.sendMessage(Number(channelId), chunk, {
          reply_to_message_id: replyTo ? Number(replyTo) : undefined,
        });
      }
    }
  }

  async function sendTyping(channelId: string): Promise<void> {
    try {
      await bot.api.sendChatAction(Number(channelId), 'typing');
    } catch (err) {
      log.debug({ err }, 'failed to send typing indicator');
    }
  }

  async function stop(): Promise<void> {
    await bot.stop();
    log.info('telegram bot stopped');
  }

  return { platform, tradecraft, start, sendResponse, sendTyping, stop };
}
