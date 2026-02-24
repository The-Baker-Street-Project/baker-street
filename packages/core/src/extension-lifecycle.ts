/**
 * ExtensionDiscovery — abstract contract for discovering and tracking extensions.
 *
 * Extensions are pod-based tool providers that announce themselves via messaging
 * and expose tools via MCP HTTP. This interface abstracts the discovery mechanism
 * so enterprise deployments can add authorization, rate limiting, etc.
 */

export interface ExtensionInfo {
  /** Unique extension identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Semantic version */
  version: string;
  /** MCP server URL */
  url: string;
  /** List of tool names this extension provides */
  tools: string[];
  /** Current status */
  status: 'online' | 'offline';
}

export interface ExtensionDiscovery {
  /** Register a handler for new extension announcements */
  onAnnounce(handler: (ext: ExtensionInfo) => void): void;
  /** Register a handler for extensions going offline */
  onOffline(handler: (extId: string) => void): void;
  /** Get all currently online extensions */
  getOnlineExtensions(): ExtensionInfo[];
}
