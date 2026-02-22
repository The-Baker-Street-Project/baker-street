import { logger } from '@bakerst/shared';
import { loadConfig } from './config.js';
import { createBrainClient } from './brain-client.js';
import { initMappingDb, getConversationId, setConversationId, closeMappingDb } from './mapping-db.js';
import type { ChannelAdapter, InboundMessage } from './types.js';

const log = logger.child({ module: 'gateway' });

async function main() {
  log.info('starting gateway service');

  const config = loadConfig();

  // Initialize mapping database
  initMappingDb(config.dataDir);

  // Initialize brain client
  const brain = createBrainClient(config.brainUrl);

  // Collect enabled adapters
  const adapters: ChannelAdapter[] = [];

  if (config.telegram.enabled) {
    const { createTelegramAdapter } = await import('./adapters/telegram.js');
    adapters.push(createTelegramAdapter(config.telegram.botToken, config.telegram.allowedChatIds));
  }

  if (config.discord.enabled) {
    const { createDiscordAdapter } = await import('./adapters/discord.js');
    adapters.push(createDiscordAdapter(config.discord.botToken, config.discord.allowedChannelIds));
  }

  if (adapters.length === 0) {
    log.warn('no adapters enabled — exiting');
    process.exit(0);
  }

  // Shared message handler
  async function handleMessage(msg: InboundMessage): Promise<void> {
    const { channel, text } = msg;
    const adapter = adapters.find((a) => a.platform === channel.platform);
    if (!adapter) {
      log.error({ platform: channel.platform }, 'no adapter for platform');
      return;
    }

    // Resolve conversation mapping
    const existingConversationId = getConversationId(channel.platform, channel.platformThreadId);

    // Start typing indicator loop
    let typingActive = true;
    const typingLoop = (async () => {
      while (typingActive) {
        await adapter.sendTyping(channel);
        await new Promise((r) => setTimeout(r, 4000));
      }
    })();

    try {
      // Call brain via streaming
      let fullResponse = '';
      let streamConversationId: string | undefined;
      let toolCallCount = 0;

      for await (const event of brain.chatStream(text, existingConversationId, channel.platform)) {
        if (event.type === 'delta' && event.text) {
          fullResponse += event.text;
        } else if (event.type === 'tool_result') {
          toolCallCount++;
        } else if (event.type === 'done') {
          streamConversationId = event.conversationId;
        } else if (event.type === 'error') {
          throw new Error(event.message ?? 'stream error from brain');
        }
      }

      const conversationId = streamConversationId ?? existingConversationId;

      // Store mapping if new
      if (!existingConversationId && conversationId) {
        setConversationId(channel.platform, channel.platformThreadId, conversationId);
        log.info(
          { platform: channel.platform, threadId: channel.platformThreadId, conversationId },
          'new conversation mapping created',
        );
      }

      // Send response
      await adapter.sendResponse({ channel, text: fullResponse || '(no response)' });

      log.info(
        { platform: channel.platform, userName: channel.userName, conversationId, toolCallCount },
        'message handled',
      );
    } catch (err) {
      log.error({ err, platform: channel.platform, threadId: channel.platformThreadId }, 'failed to handle message');
      try {
        await adapter.sendResponse({
          channel,
          text: 'Sorry, I ran into an error processing your message. Please try again.',
        });
      } catch {
        log.error('failed to send error response');
      }
    } finally {
      typingActive = false;
      await typingLoop;
    }
  }

  // Start all adapters (failures are non-fatal so one bad token doesn't kill the others)
  const started: ChannelAdapter[] = [];
  for (const adapter of adapters) {
    try {
      await adapter.start(handleMessage);
      started.push(adapter);
      log.info({ platform: adapter.platform }, 'adapter started');
    } catch (err) {
      log.error({ err, platform: adapter.platform }, 'adapter failed to start — skipping');
    }
  }

  if (started.length === 0) {
    log.fatal('all adapters failed to start — exiting');
    process.exit(1);
  }

  // Replace adapters list with only the ones that started
  adapters.length = 0;
  adapters.push(...started);

  log.info({ adapters: adapters.map((a) => a.platform) }, 'gateway ready');

  // Graceful shutdown
  const shutdown = async () => {
    log.info('shutting down');
    for (const adapter of adapters) {
      await adapter.stop().catch((err) => log.error({ err }, 'adapter stop error'));
    }
    closeMappingDb();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log.fatal({ err }, 'gateway failed to start');
  process.exit(1);
});
