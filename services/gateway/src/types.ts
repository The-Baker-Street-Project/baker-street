export interface ChannelInfo {
  platform: string;
  platformThreadId: string;
  userName?: string;
  userId?: string;
}

export interface InboundMessage {
  channel: ChannelInfo;
  text: string;
  platformMessageId?: string;
}

export interface OutboundMessage {
  channel: ChannelInfo;
  text: string;
}

export interface ChannelAdapter {
  platform: string;
  start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void>;
  sendResponse(msg: OutboundMessage): Promise<void>;
  sendTyping(channel: ChannelInfo): Promise<void>;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Door Policy types
// ---------------------------------------------------------------------------

export type DoorPolicyMode = 'open' | 'card' | 'list' | 'landlord';

export type SenderStatus = 'approved' | 'blocked' | 'pending';

export interface DoorPolicyEntry {
  platform: string;
  senderId: string;
  status: SenderStatus;
  pairedAt: string | null;
  createdAt: string;
}

export interface PairingChallenge {
  code: string;
  platform: string | null;
  expiresAt: string;
  createdAt: string;
}

export type DoorPolicyCheckResult =
  | { action: 'allow' }
  | { action: 'challenge'; message: string }
  | { action: 'validate_code'; code: string }
  | { action: 'deny' };
