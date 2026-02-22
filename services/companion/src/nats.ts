import { connect, type NatsConnection, type Subscription, JSONCodec } from 'nats';
import { Subjects, type CompanionAnnounce, type CompanionHeartbeat, type CompanionTask, type CompanionTaskProgress, type CompanionTaskResult } from '@bakerst/shared';
import type { CompanionConfig } from './config.js';
import { hostname } from 'node:os';

const jc = JSONCodec();
const HEARTBEAT_INTERVAL = 30_000;
const VERSION = '0.1.0';

export class CompanionNatsClient {
  private nc!: NatsConnection;
  private config: CompanionConfig;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private startTime = Date.now();
  private activeTasks = 0;
  private taskSub?: Subscription;

  constructor(config: CompanionConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    this.nc = await connect({
      servers: this.config.nats.url,
      name: `companion-${this.config.id}`,
    });
  }

  async announce(): Promise<void> {
    const msg: CompanionAnnounce = {
      id: this.config.id,
      hostname: hostname(),
      version: VERSION,
      capabilities: this.config.capabilities,
      paths: this.config.paths,
      maxConcurrent: this.config.maxConcurrent,
      platform: process.platform,
      arch: process.arch,
    };
    this.nc.publish(Subjects.COMPANION_ANNOUNCE, jc.encode(msg));
  }

  startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const hb: CompanionHeartbeat = {
        id: this.config.id,
        timestamp: new Date().toISOString(),
        uptime: Date.now() - this.startTime,
        activeTasks: this.activeTasks,
        load: 0, // TODO: os.loadavg()[0]
        memoryUsedPct: Math.round((process.memoryUsage.rss() / (1024 * 1024 * 1024)) * 100),
      };
      this.nc.publish(Subjects.companionHeartbeat(this.config.id), jc.encode(hb));
    }, HEARTBEAT_INTERVAL);
  }

  subscribeToTasks(handler: (task: CompanionTask) => Promise<void>): void {
    this.taskSub = this.nc.subscribe(Subjects.companionTask(this.config.id));
    (async () => {
      for await (const msg of this.taskSub!) {
        const task = jc.decode(msg.data) as CompanionTask;
        this.activeTasks++;
        try {
          await handler(task);
        } finally {
          this.activeTasks--;
        }
      }
    })();
  }

  publishProgress(progress: CompanionTaskProgress): void {
    this.nc.publish(
      Subjects.companionTaskProgress(this.config.id),
      jc.encode(progress),
    );
  }

  publishResult(result: CompanionTaskResult): void {
    this.nc.publish(
      Subjects.companionTaskResult(this.config.id),
      jc.encode(result),
    );
  }

  async shutdown(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.taskSub?.unsubscribe();
    await this.nc.drain();
  }
}
