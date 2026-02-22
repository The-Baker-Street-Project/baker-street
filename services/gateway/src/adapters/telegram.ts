import { Bot, type Context } from 'grammy';
import { logger } from '@bakerst/shared';
import type { ChannelAdapter, ChannelInfo, InboundMessage, OutboundMessage } from '../types.js';
import { splitMessage } from '../util.js';

const log = logger.child({ module: 'telegram' });

const TELEGRAM_MAX_LENGTH = 4096;

export function createTelegramAdapter(
  botToken: string,
  allowedChatIds: string[],
): ChannelAdapter {
  const bot = new Bot(botToken);
  const allowedSet = new Set(allowedChatIds);
  const filterEnabled = allowedSet.size > 0;

  function isAllowed(chatId: number): boolean {
    if (!filterEnabled) return true;
    return allowedSet.has(String(chatId));
  }

  async function start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    bot.on('message:text', async (ctx: Context) => {
      const msg = ctx.message!;
      const chatId = msg.chat.id;

      if (!isAllowed(chatId)) {
        log.warn({ chatId }, 'message from disallowed chat, ignoring');
        return;
      }

      const channel: ChannelInfo = {
        platform: 'telegram',
        platformThreadId: String(chatId),
        userName: msg.from?.first_name ?? msg.from?.username,
        userId: msg.from ? String(msg.from.id) : undefined,
      };

      log.info(
        { chatId, userName: channel.userName, textLength: msg.text!.length },
        'received telegram message',
      );

      await onMessage({
        channel,
        text: msg.text!,
        platformMessageId: String(msg.message_id),
      });
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

  async function sendResponse(msg: OutboundMessage): Promise<void> {
    const chatId = msg.channel.platformThreadId;
    const chunks = splitMessage(msg.text, TELEGRAM_MAX_LENGTH);

    for (const chunk of chunks) {
      try {
        await bot.api.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
      } catch {
        // Markdown parse failed — retry without formatting
        log.warn({ chatId }, 'markdown send failed, retrying as plain text');
        await bot.api.sendMessage(chatId, chunk);
      }
    }
  }

  async function sendTyping(channel: ChannelInfo): Promise<void> {
    try {
      await bot.api.sendChatAction(channel.platformThreadId, 'typing');
    } catch (err) {
      log.debug({ err }, 'failed to send typing indicator');
    }
  }

  async function stop(): Promise<void> {
    await bot.stop();
    log.info('telegram bot stopped');
  }

  return { platform: 'telegram', start, sendResponse, sendTyping, stop };
}
