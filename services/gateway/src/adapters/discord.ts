import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextChannel,
  type DMChannel,
} from 'discord.js';
import {
  logger,
  type IrregularAdapter,
  type IrregularDispatch,
  createIrregularDispatch,
  DISCORD_TRADECRAFT,
} from '@bakerst/shared';
import { splitMessage } from '../util.js';

const log = logger.child({ module: 'discord' });

const DISCORD_MAX_LENGTH = 2000;

export function createDiscordAdapter(
  botToken: string,
  allowedChannelIds: string[],
): IrregularAdapter {
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
  const platform = 'discord';
  const tradecraft = DISCORD_TRADECRAFT;

  function isAllowed(channelId: string, isDM: boolean): boolean {
    if (isDM) return true;
    if (!filterEnabled) return true;
    return allowedSet.has(channelId);
  }

  async function start(onDispatch: (dispatch: IrregularDispatch) => Promise<void>): Promise<void> {
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

      const senderName = message.member?.displayName ?? message.author.username;

      log.info(
        { channelId, userName: senderName, isDM, textLength: text.length },
        'received discord message',
      );

      const dispatch = createIrregularDispatch({
        platform,
        channelId,
        senderId: message.author.id,
        senderName,
        text,
        platformMessageId: message.id,
        channelData: {
          isDM,
          guildId: message.guildId,
        },
      });

      await onDispatch(dispatch);
    });

    await client.login(botToken);
    log.info({ username: client.user?.tag }, 'discord bot started');
  }

  async function sendResponse(channelId: string, text: string, _replyTo?: string): Promise<void> {
    const channel = await client.channels.fetch(channelId) as TextChannel | DMChannel | null;
    if (!channel || !('send' in channel)) {
      log.error({ channelId }, 'could not find channel to send response');
      return;
    }

    const chunks = splitMessage(text, DISCORD_MAX_LENGTH);
    for (const chunk of chunks) {
      await channel.send(chunk);
    }
  }

  async function sendTyping(channelId: string): Promise<void> {
    try {
      const ch = await client.channels.fetch(channelId) as TextChannel | DMChannel | null;
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

  return { platform, tradecraft, start, sendResponse, sendTyping, stop };
}
