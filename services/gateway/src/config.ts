import { features, logger } from '@bakerst/shared';

const log = logger.child({ module: 'config' });

export interface GatewayConfig {
  brainUrl: string;
  dataDir: string;
  telegram: {
    enabled: boolean;
    botToken: string;
    allowedChatIds: string[];
  };
  discord: {
    enabled: boolean;
    botToken: string;
    allowedChannelIds: string[];
  };
}

function parseCommaSeparated(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(): GatewayConfig {
  const brainUrl = process.env.BRAIN_URL;
  if (!brainUrl) {
    throw new Error('BRAIN_URL is required');
  }

  const telegramToken = process.env.TELEGRAM_BOT_TOKEN ?? '';
  const discordToken = process.env.DISCORD_BOT_TOKEN ?? '';

  const config: GatewayConfig = {
    brainUrl,
    dataDir: process.env.DATA_DIR ?? '/data',
    telegram: {
      enabled: !!telegramToken && features.isEnabled('telegram'),
      botToken: telegramToken,
      allowedChatIds: parseCommaSeparated(process.env.TELEGRAM_ALLOWED_CHAT_IDS),
    },
    discord: {
      enabled: !!discordToken && features.isEnabled('discord'),
      botToken: discordToken,
      allowedChannelIds: parseCommaSeparated(process.env.DISCORD_ALLOWED_CHANNEL_IDS),
    },
  };

  if (!config.telegram.enabled && !config.discord.enabled) {
    log.warn('no adapter tokens configured — gateway has nothing to do');
  }

  if (config.telegram.enabled) {
    log.info(
      { allowedChatIds: config.telegram.allowedChatIds.length || 'all' },
      'telegram adapter enabled',
    );
  }
  if (config.discord.enabled) {
    log.info(
      { allowedChannelIds: config.discord.allowedChannelIds.length || 'all' },
      'discord adapter enabled',
    );
  }

  return config;
}
