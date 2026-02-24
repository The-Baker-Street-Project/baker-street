/**
 * Model Router types — provider-agnostic model configuration and routing.
 *
 * These types define the configuration schema for routing LLM requests
 * to different providers (Anthropic, OpenRouter, Ollama, OpenAI-compatible).
 */

// ---------------------------------------------------------------------------
// Provider enum
// ---------------------------------------------------------------------------

export type ModelProvider = 'anthropic' | 'openrouter' | 'ollama' | 'openai-compatible';

// ---------------------------------------------------------------------------
// Provider credential configuration
// ---------------------------------------------------------------------------

export interface AnthropicProviderConfig {
  provider: 'anthropic';
  /** OAuth token (sk-ant-oat prefix) — takes priority over apiKey */
  oauthToken?: string;
  /** Standard API key */
  apiKey?: string;
}

export interface OpenRouterProviderConfig {
  provider: 'openrouter';
  apiKey: string;
  /** Override base URL (default: https://openrouter.ai/api/v1) */
  baseURL?: string;
}

export interface OllamaProviderConfig {
  provider: 'ollama';
  /** Base URL for the Ollama server (default: http://localhost:11434/v1) */
  baseURL?: string;
}

export interface OpenAICompatibleProviderConfig {
  provider: 'openai-compatible';
  apiKey?: string;
  baseURL: string;
}

export type ProviderConfig =
  | AnthropicProviderConfig
  | OpenRouterProviderConfig
  | OllamaProviderConfig
  | OpenAICompatibleProviderConfig;

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

export interface ModelDefinition {
  /** Unique id used to reference this model in roles/overrides (e.g. "sonnet-4") */
  id: string;
  /** Model string sent to the provider API (e.g. "claude-sonnet-4-20250514") */
  modelName: string;
  /** Which provider to use */
  provider: ModelProvider;
  /** Max tokens for this model's responses */
  maxTokens: number;
  /** Approximate cost per 1M input tokens (USD), used for cost-limit checks */
  costPer1MInput?: number;
  /** Approximate cost per 1M output tokens (USD) */
  costPer1MOutput?: number;
}

// ---------------------------------------------------------------------------
// Role assignments & overrides
// ---------------------------------------------------------------------------

/** Named roles that map to model IDs */
export interface ModelRoles {
  /** Primary agent model (brain chat + worker agent tasks) */
  agent: string;
  /** Observer model (cheaper, used for observation extraction) */
  observer: string;
  /** Reflector model (needs judgment — Sonnet-class for compaction quality) */
  reflector?: string;
  /** Optional: worker-specific override; falls back to agent */
  worker?: string;
}

// ---------------------------------------------------------------------------
// Top-level router configuration
// ---------------------------------------------------------------------------

export interface ModelRouterConfig {
  /** All available provider configurations keyed by provider name */
  providers: Record<string, ProviderConfig>;
  /** All available model definitions */
  models: ModelDefinition[];
  /** Role-to-model-id mapping */
  roles: ModelRoles;
  /** Ordered list of model IDs to try if the primary model fails */
  fallbackChain?: string[];
}

// ---------------------------------------------------------------------------
// Provider-agnostic chat interfaces
// ---------------------------------------------------------------------------

/** A single content block in a message */
export type ChatContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

/** A message in the chat history */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | ChatContentBlock[];
}

/** System block for the prompt */
export interface SystemBlock {
  type: 'text';
  text: string;
}

/** Tool definition (matches Anthropic format for simplicity) */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/** Parameters for a chat request routed through the ModelRouter */
export interface ChatParams {
  /** Which role to use for model selection (defaults to 'agent') */
  role?: keyof ModelRoles;
  /** Override the model ID for this specific request */
  modelOverride?: string;
  /** System prompt blocks */
  system?: SystemBlock[];
  /** Conversation messages */
  messages: ChatMessage[];
  /** Tool definitions */
  tools?: ToolDefinition[];
  /** Maximum tokens in the response */
  maxTokens?: number;
}

/** Response from a non-streaming chat call */
export interface ChatResponse {
  /** The content blocks returned by the model */
  content: ChatContentBlock[];
  /** Why the model stopped generating */
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | string;
  /** Model ID that was actually used */
  model: string;
  /** Token usage, if available */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    /** Tokens written to prompt cache this request (Anthropic only) */
    cacheCreationInputTokens?: number;
    /** Tokens read from prompt cache this request (Anthropic only) */
    cacheReadInputTokens?: number;
  };
}

// ---------------------------------------------------------------------------
// Streaming event types
// ---------------------------------------------------------------------------

export type ModelStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'content_block_start'; index: number; contentBlock: ChatContentBlock }
  | { type: 'message_done'; response: ChatResponse };
