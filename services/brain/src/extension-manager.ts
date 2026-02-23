import { logger, Subjects, codec, SkillTier, type ExtensionAnnounce, type ExtensionHeartbeat, type SkillMetadata } from '@bakerst/shared';
import type { NatsConnection, Subscription } from 'nats';
import type { SkillRegistry } from './skill-registry.js';
import { McpClientManager } from './mcp-client.js';
import { upsertSkill, getSkill, listSkills } from './db.js';
import { clearToolsCache } from './agent.js';

const log = logger.child({ module: 'extension-manager' });

const HEARTBEAT_TIMEOUT = 90_000; // 3 missed heartbeats (30s * 3)
const MONITOR_INTERVAL = 30_000;
const CONNECT_RETRY_DELAY = 3_000; // retry initial connect after 3s
const MAX_CONNECT_RETRIES = 3;

interface TrackedExtension {
  announce: ExtensionAnnounce;
  lastSeen: number;
  online: boolean;
  connected: boolean;
}

export class ExtensionManager {
  private nc: NatsConnection;
  private skillRegistry: SkillRegistry;
  private announceSub?: Subscription;
  private heartbeatSubs = new Map<string, Subscription>();
  private extensions = new Map<string, TrackedExtension>();
  private monitorTimer?: ReturnType<typeof setInterval>;

  constructor(nc: NatsConnection, skillRegistry: SkillRegistry, private mcpClient?: McpClientManager) {
    this.nc = nc;
    this.skillRegistry = skillRegistry;
  }

  async start(): Promise<void> {
    // Reconnect to previously known extensions from database
    await this.reconnectKnownExtensions();

    // Listen for extension announcements
    this.announceSub = this.nc.subscribe(Subjects.EXTENSION_ANNOUNCE);
    (async () => {
      for await (const msg of this.announceSub!) {
        try {
          const announce = codec.decode(msg.data) as ExtensionAnnounce;
          await this.handleAnnounce(announce);
        } catch (err) {
          log.error({ err }, 'failed to process extension announcement');
        }
      }
    })();

    // Start monitor for offline detection
    this.monitorTimer = setInterval(() => this.checkOffline(), MONITOR_INTERVAL);

    log.info('ExtensionManager started');
  }

  private async reconnectKnownExtensions(): Promise<void> {
    const extensionSkills = listSkills().filter((s) => s.owner === 'extension');
    if (extensionSkills.length === 0) return;

    log.info({ count: extensionSkills.length }, 'reconnecting to known extensions from database');

    for (const skill of extensionSkills) {
      const extId = skill.id.replace(/^ext-/, '');
      this.extensions.set(extId, {
        announce: {
          id: extId,
          name: skill.name,
          version: skill.version,
          description: skill.description,
          mcpUrl: skill.httpUrl ?? '',
          transport: (skill.transport as 'streamable-http' | 'http') ?? 'streamable-http',
          tags: skill.tags,
        },
        lastSeen: Date.now(),
        online: true,
        connected: false,
      });

      await this.connectWithRetry(extId, skill);
      this.subscribeToHeartbeat(extId);
    }
  }

  private skillId(extensionId: string): string {
    return `ext-${extensionId}`;
  }

  private async handleAnnounce(announce: ExtensionAnnounce): Promise<void> {
    const sid = this.skillId(announce.id);

    // Build skill metadata for this extension
    const skill: SkillMetadata = {
      id: sid,
      name: announce.name,
      version: announce.version,
      description: announce.description,
      tier: SkillTier.Tier3,
      transport: announce.transport ?? 'streamable-http',
      enabled: true,
      config: {},
      httpUrl: announce.mcpUrl,
      owner: 'extension',
      tags: announce.tags,
    };

    // Persist to DB
    upsertSkill(skill);

    // Track extension state
    this.extensions.set(announce.id, {
      announce,
      lastSeen: Date.now(),
      online: true,
      connected: false,
    });

    // Connect with retry (pod may not be fully ready yet)
    await this.connectWithRetry(announce.id, skill);

    // Subscribe to heartbeat
    this.subscribeToHeartbeat(announce.id);

    log.info(
      { id: announce.id, name: announce.name, mcpUrl: announce.mcpUrl, tools: announce.tools },
      'extension registered',
    );
  }

  private async connectWithRetry(id: string, skill: SkillMetadata): Promise<void> {
    for (let attempt = 1; attempt <= MAX_CONNECT_RETRIES; attempt++) {
      try {
        await this.skillRegistry.connectAndRegister(skill);
        const ext = this.extensions.get(id);
        if (ext) ext.connected = true;
        clearToolsCache();
        log.info({ id, attempt }, 'extension MCP connected');
        return;
      } catch (err) {
        log.warn({ err, id, attempt, maxRetries: MAX_CONNECT_RETRIES }, 'failed to connect extension MCP server, retrying');
        if (attempt < MAX_CONNECT_RETRIES) {
          await new Promise((r) => setTimeout(r, CONNECT_RETRY_DELAY));
        }
      }
    }
    log.error({ id }, 'failed to connect extension MCP server after retries (will retry on next heartbeat)');
  }

  private subscribeToHeartbeat(id: string): void {
    if (this.heartbeatSubs.has(id)) return;

    const sub = this.nc.subscribe(Subjects.extensionHeartbeat(id));
    this.heartbeatSubs.set(id, sub);

    (async () => {
      for await (const msg of sub) {
        try {
          const _hb = codec.decode(msg.data) as ExtensionHeartbeat;
          const ext = this.extensions.get(id);
          if (ext) {
            ext.lastSeen = Date.now();

            if (!ext.online) {
              // Was offline, now back — reconnect
              ext.online = true;
              log.info({ id }, 'extension back online');
              const sid = this.skillId(id);
              const skill = getSkill(sid);
              if (skill) {
                await this.connectWithRetry(id, skill);
              }
            } else if (!ext.connected) {
              // Online but initial connect failed — retry
              const sid = this.skillId(id);
              const skill = getSkill(sid);
              if (skill) {
                try {
                  await this.skillRegistry.connectAndRegister(skill);
                  ext.connected = true;
                  clearToolsCache();
                  log.info({ id }, 'extension MCP connected on heartbeat retry');
                } catch (err) {
                  log.warn({ err, id }, 'extension MCP connect retry failed');
                }
              }
            }
          }
        } catch (err) {
          log.error({ err, id }, 'failed to process extension heartbeat');
        }
      }
    })();
  }

  private async checkOffline(): Promise<void> {
    const now = Date.now();

    for (const [id, ext] of this.extensions) {
      if (ext.online && now - ext.lastSeen > HEARTBEAT_TIMEOUT) {
        ext.online = false;
        ext.connected = false;
        const sid = this.skillId(id);

        try {
          await this.skillRegistry.disconnectSkill(sid);
          clearToolsCache();
        } catch (err) {
          log.error({ err, id }, 'failed to disconnect offline extension');
        }

        log.warn({ id }, 'extension marked offline (missed heartbeats)');
      }
    }
  }

  getExtensions(): Array<{ id: string; name: string; version: string; description: string; online: boolean; skillId: string }> {
    return Array.from(this.extensions.values()).map((ext) => ({
      id: ext.announce.id,
      name: ext.announce.name,
      version: ext.announce.version,
      description: ext.announce.description,
      online: ext.online,
      skillId: this.skillId(ext.announce.id),
    }));
  }

  shutdown(): void {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.announceSub?.unsubscribe();
    for (const sub of this.heartbeatSubs.values()) sub.unsubscribe();
    this.heartbeatSubs.clear();
    this.extensions.clear();
    log.info('ExtensionManager shut down');
  }
}
