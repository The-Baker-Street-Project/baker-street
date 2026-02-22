/** Tool definition compatible with Anthropic SDK's Tool type */
export interface PluginToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolResult {
  result: string;
  jobId?: string;
}

export interface PluginContext {
  dispatcher: unknown;
  statusTracker: unknown;
  memoryService: unknown;
  logger: {
    info(obj: Record<string, unknown>, msg?: string): void;
    warn(obj: Record<string, unknown>, msg?: string): void;
    error(obj: Record<string, unknown>, msg?: string): void;
    child(bindings: Record<string, unknown>): PluginContext['logger'];
  };
  config: Record<string, unknown>;
}

export interface TriggerEvent {
  source: string;
  event: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export interface BakerstPlugin {
  name: string;
  version: string;
  description: string;

  /** Claude tool definitions this plugin contributes */
  tools: PluginToolDefinition[];

  /** Initialize the plugin with brain context */
  init(context: PluginContext): Promise<void>;

  /** Clean shutdown */
  shutdown(): Promise<void>;

  /** Execute a tool call — brain routes by tool name */
  execute(toolName: string, input: Record<string, unknown>): Promise<ToolResult>;

  /** Optional: handle an incoming trigger event */
  onTrigger?(event: TriggerEvent): Promise<string | null>;
}
