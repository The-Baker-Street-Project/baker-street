import { randomUUID } from 'node:crypto';
import { logger, Subjects, codec, type CompanionAnnounce, type CompanionHeartbeat, type CompanionTask, type CompanionTaskResult } from '@bakerst/shared';
import type { NatsConnection, Subscription } from 'nats';
import { upsertCompanion, updateCompanionStatus, updateCompanionLastSeen, listCompanions, getCompanion, insertCompanionTask, updateCompanionTask, listCompanionTasks, type CompanionRow, type CompanionTaskRow } from './db.js';

const log = logger.child({ module: 'companion-manager' });

const HEARTBEAT_TIMEOUT = 90_000; // 3 missed heartbeats (30s * 3)
const MONITOR_INTERVAL = 30_000;

export class CompanionManager {
  private nc: NatsConnection;
  private announceSub?: Subscription;
  private heartbeatSubs = new Map<string, Subscription>();
  private resultSubs = new Map<string, Subscription>();
  private monitorTimer?: ReturnType<typeof setInterval>;

  constructor(nc: NatsConnection) {
    this.nc = nc;
  }

  async start(): Promise<void> {
    // Listen for announcements
    this.announceSub = this.nc.subscribe(Subjects.COMPANION_ANNOUNCE);
    (async () => {
      for await (const msg of this.announceSub!) {
        try {
          const announce = codec.decode(msg.data) as CompanionAnnounce;
          this.handleAnnounce(announce);
        } catch (err) {
          log.error({ err }, 'failed to process companion announcement');
        }
      }
    })();

    // Resubscribe to heartbeats for known companions
    const known = listCompanions();
    for (const irr of known) {
      this.subscribeToHeartbeat(irr.id);
      this.subscribeToResults(irr.id);
    }

    // Start monitor for offline detection
    this.monitorTimer = setInterval(() => this.checkOffline(), MONITOR_INTERVAL);

    log.info({ knownCompanions: known.length }, 'CompanionManager started');
  }

  private handleAnnounce(announce: CompanionAnnounce): void {
    upsertCompanion({
      id: announce.id,
      hostname: announce.hostname,
      version: announce.version,
      capabilities: announce.capabilities,
      paths: announce.paths,
      maxConcurrent: announce.maxConcurrent,
      platform: announce.platform,
      arch: announce.arch,
    });
    this.subscribeToHeartbeat(announce.id);
    this.subscribeToResults(announce.id);
    log.info({ id: announce.id, hostname: announce.hostname, capabilities: announce.capabilities }, 'companion registered');
  }

  private subscribeToHeartbeat(id: string): void {
    if (this.heartbeatSubs.has(id)) return;

    const sub = this.nc.subscribe(Subjects.companionHeartbeat(id));
    this.heartbeatSubs.set(id, sub);

    (async () => {
      for await (const msg of sub) {
        try {
          const _hb = codec.decode(msg.data) as CompanionHeartbeat;
          updateCompanionLastSeen(id);
        } catch (err) {
          log.error({ err, id }, 'failed to process heartbeat');
        }
      }
    })();
  }

  private subscribeToResults(id: string): void {
    if (this.resultSubs.has(id)) return;

    const sub = this.nc.subscribe(Subjects.companionTaskResult(id));
    this.resultSubs.set(id, sub);

    (async () => {
      for await (const msg of sub) {
        try {
          const result = codec.decode(msg.data) as CompanionTaskResult;
          updateCompanionTask(result.taskId, {
            status: result.status,
            result: result.result,
            error: result.error,
            durationMs: result.durationMs,
            traceId: result.traceId,
          });
          log.info({ taskId: result.taskId, companionId: id, status: result.status }, 'companion task completed');
        } catch (err) {
          log.error({ err, id }, 'failed to process task result');
        }
      }
    })();
  }

  private checkOffline(): void {
    const companions = listCompanions();
    const now = Date.now();

    for (const irr of companions) {
      if (irr.status === 'online' && irr.last_seen) {
        const lastSeen = new Date(irr.last_seen).getTime();
        if (now - lastSeen > HEARTBEAT_TIMEOUT) {
          updateCompanionStatus(irr.id, 'offline');
          log.warn({ id: irr.id }, 'companion marked offline (missed heartbeats)');
        }
      }
    }
  }

  async dispatchTask(companionId: string, params: {
    mode: 'agent' | 'script';
    goal: string;
    tools?: string[];
    timeout?: number;
  }): Promise<string> {
    const companion = getCompanion(companionId);
    if (!companion) throw new Error(`Unknown companion: ${companionId}`);
    if (companion.status !== 'online') throw new Error(`Companion ${companionId} is ${companion.status}`);

    const taskId = randomUUID();

    insertCompanionTask({
      taskId,
      companionId,
      mode: params.mode,
      goal: params.goal,
      tools: params.tools,
    });

    const task: CompanionTask = {
      taskId,
      mode: params.mode,
      goal: params.goal,
      tools: params.tools,
      timeout: params.timeout,
    };

    this.nc.publish(Subjects.companionTask(companionId), codec.encode(task));
    updateCompanionTask(taskId, { status: 'running' });
    log.info({ taskId, companionId, mode: params.mode }, 'task dispatched to companion');

    return taskId;
  }

  getCompanions(): CompanionRow[] {
    return listCompanions();
  }

  getCompanion(id: string): CompanionRow | undefined {
    return getCompanion(id);
  }

  getCompanionTasks(companionId: string): CompanionTaskRow[] {
    return listCompanionTasks(companionId);
  }

  getCapabilitiesSummary(): string {
    const companions = listCompanions().filter((i) => i.status === 'online');
    if (companions.length === 0) return 'No connected Companions.';

    return 'Connected Companions:\n' + companions.map((irr) => {
      const caps = JSON.parse(irr.capabilities) as string[];
      const paths = irr.paths ? (JSON.parse(irr.paths) as string[]).join(', ') : 'none';
      return `- ${irr.id} (${irr.status}): ${caps.join(', ')}\n  Paths: ${paths}`;
    }).join('\n');
  }

  shutdown(): void {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.announceSub?.unsubscribe();
    for (const sub of this.heartbeatSubs.values()) sub.unsubscribe();
    for (const sub of this.resultSubs.values()) sub.unsubscribe();
    this.heartbeatSubs.clear();
    this.resultSubs.clear();
    log.info('CompanionManager shut down');
  }
}
