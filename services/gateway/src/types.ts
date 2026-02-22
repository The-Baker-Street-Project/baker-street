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
