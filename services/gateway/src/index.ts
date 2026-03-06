import { logger, type IrregularAdapter, type IrregularDispatch } from '@bakerst/shared';
import { loadConfig } from './config.js';
import { createBrainClient } from './brain-client.js';
import { initMappingDb, getDb, getConversationId, setConversationId, closeMappingDb } from './mapping-db.js';
import { DoorPolicyManager } from './door-policy.js';
import { startAdminApi } from './admin-api.js';

const log = logger.child({ module: 'gateway' });

async function main() {
  log.info('starting gateway service');

  const config = loadConfig();

  // Initialize mapping database
  initMappingDb(config.dataDir);

  // Initialize door policy
  const doorPolicy = new DoorPolicyManager(getDb(), config.doorPolicy);

  // Auto-import static allowlists when in card mode
  if (config.doorPolicy === 'card') {
    if (config.telegram.allowedChatIds.length > 0) {
      doorPolicy.importAllowlist('telegram', config.telegram.allowedChatIds);
    }
    if (config.discord.allowedChannelIds.length > 0) {
      doorPolicy.importAllowlist('discord', config.discord.allowedChannelIds);
    }
  }

  // Start admin API
  startAdminApi(doorPolicy);

  // Initialize brain client
  const brain = createBrainClient(config.brainUrl);

  // Collect enabled adapters
  const adapters: IrregularAdapter[] = [];

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

  // Resolve static allowlist for a given platform
  function getStaticAllowlist(platform: string): string[] | undefined {
    if (platform === 'telegram' && config.telegram.allowedChatIds.length > 0) {
      return config.telegram.allowedChatIds;
    }
    if (platform === 'discord' && config.discord.allowedChannelIds.length > 0) {
      return config.discord.allowedChannelIds;
    }
    return undefined;
  }

  // Shared dispatch handler
  async function handleDispatch(dispatch: IrregularDispatch): Promise<void> {
    const { platform, channelId, senderId, text } = dispatch;
    const adapter = adapters.find((a) => a.platform === platform);
    if (!adapter) {
      log.error({ platform }, 'no adapter for platform');
      return;
    }

    // --- Door policy check ---
    const staticAllowed = getStaticAllowlist(platform);
    const policyResult = doorPolicy.checkMessage(platform, senderId, text, staticAllowed);

    if (policyResult.action === 'deny') {
      log.info({ platform, senderId }, 'message denied by door policy');
      return;
    }

    if (policyResult.action === 'challenge') {
      log.info({ platform, senderId }, 'challenging unknown sender');
      await adapter.sendResponse(channelId, policyResult.message);
      return;
    }

    if (policyResult.action === 'validate_code') {
      const result = doorPolicy.attemptPairing(platform, senderId, policyResult.code);
      log.info({ platform, senderId, success: result.success }, 'pairing attempt');
      await adapter.sendResponse(channelId, result.message);
      if (!result.success) return;
      // If pairing succeeded, fall through to handle the next real message
      // (the code itself was consumed, so we return and wait for their next message)
      return;
    }

    // action === 'allow' — proceed with normal message handling

    // Resolve conversation mapping
    const existingConversationId = getConversationId(platform, channelId);

    // Start typing indicator loop
    let typingActive = true;
    const typingLoop = (async () => {
      while (typingActive) {
        await adapter.sendTyping(channelId);
        await new Promise((r) => setTimeout(r, 4000));
      }
    })();

    try {
      // Call brain via streaming
      let fullResponse = '';
      let streamConversationId: string | undefined;
      let toolCallCount = 0;

      for await (const event of brain.chatStream(text, existingConversationId, platform)) {
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
        setConversationId(platform, channelId, conversationId);
        log.info(
          { platform, threadId: channelId, conversationId },
          'new conversation mapping created',
        );
      }

      // Send response
      await adapter.sendResponse(channelId, fullResponse || '(no response)', dispatch.platformMessageId);

      log.info(
        { platform, senderName: dispatch.senderName, conversationId, toolCallCount },
        'message handled',
      );
    } catch (err) {
      log.error({ err, platform, threadId: channelId }, 'failed to handle message');
      try {
        await adapter.sendResponse(
          channelId,
          'Sorry, I ran into an error processing your message. Please try again.',
        );
      } catch {
        log.error('failed to send error response');
      }
    } finally {
      typingActive = false;
      await typingLoop;
    }
  }

  // Start all adapters (failures are non-fatal so one bad token doesn't kill the others)
  const started: IrregularAdapter[] = [];
  for (const adapter of adapters) {
    try {
      await adapter.start(handleDispatch);
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
