import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// IrregularDispatch — the universal message format
// ---------------------------------------------------------------------------

/**
 * An IrregularDispatch is the report an Irregular brings back.
 * Brain works with dispatches only — never needs to know which Irregular delivered.
 * Named IrregularDispatch to avoid collision with JobDispatch in shared types.
 */
export interface IrregularDispatch {
  /** Unique message ID (UUID) */
  id: string;
  /** Platform identifier: 'telegram', 'discord', etc. */
  platform: string;
  /** Platform-specific channel/thread ID */
  channelId: string;
  /** Platform-specific sender ID */
  senderId: string;
  /** Human-readable sender name */
  senderName: string;
  /** Message text content */
  text: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Original platform message ID (for replies/edits) */
  platformMessageId?: string;
  /** Platform-specific data the brain shouldn't need but adapters might */
  channelData?: Record<string, unknown>;
}

/** Create an IrregularDispatch with generated id and timestamp */
export function createIrregularDispatch(
  fields: Omit<IrregularDispatch, 'id' | 'timestamp'> & { timestamp?: string },
): IrregularDispatch {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    ...fields,
  };
}

/** Runtime type guard for IrregularDispatch */
export function isIrregularDispatch(value: unknown): value is IrregularDispatch {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.platform === 'string' &&
    typeof obj.channelId === 'string' &&
    typeof obj.senderId === 'string' &&
    typeof obj.senderName === 'string' &&
    typeof obj.text === 'string' &&
    typeof obj.timestamp === 'string'
  );
}

// ---------------------------------------------------------------------------
// Tradecraft — what an Irregular can do
// ---------------------------------------------------------------------------

export type ChatType = 'direct' | 'group' | 'channel' | 'thread';

/** Capabilities declaration for an adapter */
export interface Tradecraft {
  chatTypes: ChatType[];
  threads: boolean;
  reactions: boolean;
  richEmbeds: boolean;
  media: boolean;
  maxMessageLength: number;
}

// ---------------------------------------------------------------------------
// IrregularAdapter — the new adapter contract
// ---------------------------------------------------------------------------

/**
 * An Irregular registers with the gateway and declares its tradecraft.
 * Replaces the old ChannelAdapter interface.
 */
export interface IrregularAdapter {
  /** Platform identifier: 'telegram', 'discord', etc. */
  platform: string;
  /** What this Irregular can do */
  tradecraft: Tradecraft;
  /** Start listening. Call onDispatch for each inbound message. */
  start(onDispatch: (dispatch: IrregularDispatch) => Promise<void>): Promise<void>;
  /** Send a response to a channel */
  sendResponse(channelId: string, text: string, replyTo?: string): Promise<void>;
  /** Send typing indicator */
  sendTyping(channelId: string): Promise<void>;
  /** Graceful shutdown */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Known tradecraft for built-in adapters
// ---------------------------------------------------------------------------

export const TELEGRAM_TRADECRAFT: Tradecraft = {
  chatTypes: ['direct', 'group'],
  threads: false,
  reactions: true,
  richEmbeds: false,
  media: true,
  maxMessageLength: 4096,
};

export const DISCORD_TRADECRAFT: Tradecraft = {
  chatTypes: ['direct', 'group', 'channel', 'thread'],
  threads: true,
  reactions: true,
  richEmbeds: true,
  media: true,
  maxMessageLength: 2000,
};
