import {
  connect,
  type NatsConnection,
  type JetStreamClient,
  type JetStreamManager,
  AckPolicy,
  DeliverPolicy,
  RetentionPolicy,
  StorageType,
  JSONCodec,
  nanos,
} from 'nats';
import { logger } from './logger.js';

const log = logger.child({ module: 'nats' });

export const codec = JSONCodec();

export async function connectNats(name: string): Promise<NatsConnection> {
  const servers = process.env.NATS_URL ?? 'nats://localhost:4222';
  log.info({ servers, name }, 'connecting to NATS');

  const nc = await connect({ servers, name });
  log.info('connected to NATS');

  nc.closed().then((err) => {
    if (err) {
      log.error({ err }, 'NATS connection closed with error');
    } else {
      log.info('NATS connection closed');
    }
  });

  return nc;
}

export async function drainAndClose(nc: NatsConnection): Promise<void> {
  log.info('draining NATS connection');
  await nc.drain();
}

// ── JetStream helpers ─────────────────────────────────────────────

export async function getJetStreamManager(nc: NatsConnection): Promise<JetStreamManager> {
  const jsm = await nc.jetstreamManager();
  log.info('JetStream manager created');
  return jsm;
}

export function getJetStreamClient(nc: NatsConnection): JetStreamClient {
  const js = nc.jetstream();
  log.info('JetStream client created');
  return js;
}

/**
 * Ensure a stream exists with the given configuration.
 * If the stream already exists, this is a no-op (logs and returns existing info).
 */
export async function ensureStream(
  jsm: JetStreamManager,
  opts: {
    name: string;
    subjects: string[];
    retention?: RetentionPolicy;
    storage?: StorageType;
    maxAge?: number; // milliseconds — converted to nanos internally
  },
): Promise<void> {
  const { name, subjects, retention, storage, maxAge } = opts;
  try {
    const info = await jsm.streams.info(name);
    log.info({ stream: name, subjects: info.config.subjects }, 'stream already exists');
  } catch {
    await jsm.streams.add({
      name,
      subjects,
      retention: retention ?? RetentionPolicy.Workqueue,
      storage: storage ?? StorageType.File,
      ...(maxAge !== undefined && { max_age: nanos(maxAge) }),
    });
    log.info({ stream: name, subjects }, 'stream created');
  }
}

/**
 * Ensure a durable pull consumer exists on the given stream.
 * If the consumer already exists, this is a no-op.
 */
export async function ensureConsumer(
  jsm: JetStreamManager,
  opts: {
    stream: string;
    name: string;
    ackPolicy?: AckPolicy;
    deliverPolicy?: DeliverPolicy;
    ackWait?: number; // milliseconds — converted to nanos internally
    maxDeliver?: number;
    filterSubject?: string;
  },
): Promise<void> {
  const { stream, name: consumerName, ackPolicy, deliverPolicy, ackWait, maxDeliver, filterSubject } = opts;
  try {
    await jsm.consumers.info(stream, consumerName);
    log.info({ stream, consumer: consumerName }, 'consumer already exists');
  } catch {
    await jsm.consumers.add(stream, {
      durable_name: consumerName,
      ack_policy: ackPolicy ?? AckPolicy.Explicit,
      deliver_policy: deliverPolicy ?? DeliverPolicy.All,
      ...(ackWait !== undefined && { ack_wait: nanos(ackWait) }),
      ...(maxDeliver !== undefined && { max_deliver: maxDeliver }),
      ...(filterSubject !== undefined && { filter_subject: filterSubject }),
    });
    log.info({ stream, consumer: consumerName }, 'consumer created');
  }
}

export type { JetStreamClient, JetStreamManager };
