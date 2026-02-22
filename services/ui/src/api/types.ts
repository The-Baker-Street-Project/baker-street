export interface Conversation {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface Message {
  id: number;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

export interface JobStatus {
  jobId: string;
  type: string;
  status: 'dispatched' | 'received' | 'running' | 'completed' | 'failed';
  result?: string;
  error?: string;
  durationMs?: number;
  receivedAt: string;
  completedAt?: string;
}

export interface StreamEvent {
  type: 'delta' | 'thinking' | 'tool_result' | 'done' | 'error';
  text?: string;
  conversationId?: string;
  tool?: string;
  input?: Record<string, unknown>;
  summary?: string;
  message?: string;
  jobIds?: string[];
  toolCallCount?: number;
}

export interface ChatResponse {
  response: string;
  conversationId: string;
}

export interface MemoryEntry {
  id: string;
  content: string;
  category: string;
  created_at: string;
  updated_at: string;
  score?: number;
}

export interface SecretEntry {
  key: string;
  value: string;
  maskedValue: string;
}

export interface SecretsUpdateResponse {
  ok: boolean;
  count: number;
}

export interface RestartResponse {
  ok: boolean;
  restarted: string[];
}

export interface Skill {
  id: string;
  name: string;
  version: string;
  description: string;
  tier: 'instruction' | 'stdio' | 'sidecar' | 'service';
  transport?: string;
  enabled: boolean;
  config: Record<string, unknown>;
  stdioCommand?: string;
  stdioArgs?: string[];
  httpUrl?: string;
  instructionPath?: string;
  instructionContent?: string;
  connected?: boolean;
  toolCount?: number;
  tags?: string[];
}

export interface Toolbox {
  name: string;
  description: string;
  image: string;
  packages: string[];
  status: 'built' | 'not_built' | 'building' | 'error';
  usedByRecipes: number;
  lastBuilt?: string;
}

export interface SkillTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface SkillDetail extends Skill {
  tools: SkillTool[];
}

export interface Model {
  id: string;
  modelName: string;
  provider: string;
  maxTokens: number;
  costPer1MInput?: number;
  costPer1MOutput?: number;
  roles: string[];
}

export interface ModelConfig {
  providers: Record<string, { provider: string; [key: string]: unknown }>;
  models: Model[];
  roles: Record<string, string>;
  fallbackChain?: string[];
}

export interface SystemHealth {
  brain: { status: 'healthy' | 'unhealthy' };
  nats: { status: 'healthy' | 'unhealthy' | 'unknown' };
  qdrant: { status: 'healthy' | 'unhealthy' | 'unknown' };
  db: { status: 'healthy' | 'unhealthy' };
  [key: string]: { status: string; detail?: string };
}

export interface SkillStatus {
  id: string;
  name: string;
  tier: string;
  enabled: boolean;
  connected: boolean;
}

export interface RegistryServer {
  name: string;
  description: string;
  version_detail?: {
    version?: string;
    packages?: Array<{
      registry_name?: string;
      name?: string;
      version?: string;
      runtime?: string;
      environment_variables?: Array<{
        name: string;
        description?: string;
        required?: boolean;
      }>;
    }>;
    remotes?: Array<{
      transport_type?: string;
      url?: string;
    }>;
  };
  repository?: { url?: string };
}

export interface RegistrySearchResult {
  servers: RegistryServer[];
  next_cursor?: string;
}

export interface Schedule {
  id: string;
  name: string;
  schedule: string;
  type: 'agent' | 'command' | 'http';
  config: Record<string, unknown>;
  enabled: number;
  last_run_at: string | null;
  last_status: string | null;
  last_output: string | null;
  created_at: string;
  updated_at: string;
}

export interface PingResponse {
  status: string;
  service: string;
  mode?: string;
  features?: Record<string, boolean>;
  name?: string;
  timestamp: string;
}
