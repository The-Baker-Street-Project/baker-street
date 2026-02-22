import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextChannel,
  type DMChannel,
} from 'discord.js';
import { logger } from '@bakerst/shared';
import type { ChannelAdapter, ChannelInfo, InboundMessage, OutboundMessage } from '../types.js';
import { splitMessage } from '../util.js';

const log = logger.child({ module: 'discord' });

const DISCORD_MAX_LENGTH = 2000;

export function createDiscordAdapter(
  botToken: string,
  allowedChannelIds: string[],
): ChannelAdapter {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  const allowedSet = new Set(allowedChannelIds);
  const filterEnabled = allowedSet.size > 0;

  function isAllowed(channelId: string, isDM: boolean): boolean {
    if (isDM) return true;
    if (!filterEnabled) return true;
    return allowedSet.has(channelId);
  }

  async function start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    client.on('messageCreate', async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const isDM = !message.guild;
      const channelId = message.channel.id;

      if (!isAllowed(channelId, isDM)) return;

      let text = message.content;

      // In servers, only respond when @mentioned
      if (!isDM) {
        if (!message.mentions.has(client.user!)) return;
        // Strip the mention from the text
        text = text.replace(/<@!?\d+>/g, '').trim();
        if (!text) return;
      }

      const channel: ChannelInfo = {
        platform: 'discord',
        platformThreadId: channelId,
        userName: message.author.displayName ?? message.author.username,
        userId: message.author.id,
      };

      log.info(
        { channelId, userName: channel.userName, isDM, textLength: text.length },
        'received discord message',
      );

      await onMessage({
        channel,
        text,
        platformMessageId: message.id,
      });
    });

    await client.login(botToken);
    log.info({ username: client.user?.tag }, 'discord bot started');
  }

  async function sendResponse(msg: OutboundMessage): Promise<void> {
    const channelId = msg.channel.platformThreadId;
    const channel = await client.channels.fetch(channelId) as TextChannel | DMChannel | null;
    if (!channel || !('send' in channel)) {
      log.error({ channelId }, 'could not find channel to send response');
      return;
    }

    const chunks = splitMessage(msg.text, DISCORD_MAX_LENGTH);
    for (const chunk of chunks) {
      await channel.send(chunk);
    }
  }

  async function sendTyping(channel: ChannelInfo): Promise<void> {
    try {
      const ch = await client.channels.fetch(channel.platformThreadId) as TextChannel | DMChannel | null;
      if (ch && 'sendTyping' in ch) {
        await ch.sendTyping();
      }
    } catch (err) {
      log.debug({ err }, 'failed to send typing indicator');
    }
  }

  async function stop(): Promise<void> {
    client.destroy();
    log.info('discord bot stopped');
  }

  return { platform: 'discord', start, sendResponse, sendTyping, stop };
}
