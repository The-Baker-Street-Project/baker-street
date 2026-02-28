import { logger } from '@bakerst/shared';
import type {
  ModelRouter,
  ChatMessage,
  ChatContentBlock,
  SystemBlock,
  ToolDefinition,
} from '@bakerst/shared';
import type { RegisteredTool, ToolResult } from './types.js';

const log = logger.child({ module: 'sysadmin-agent' });

const MAX_ITERATIONS = 20;

export interface AgentTurnResult {
  response: string;
  stateTransition?: 'runtime' | 'update' | 'shutdown';
}

export interface SysAdminAgent {
  /** Process a user message and return a response */
  chat(message: string): Promise<AgentTurnResult>;
  /** Replace the system prompt and tool set (prompt hot-swap) */
  reconfigure(systemPrompt: string, tools: RegisteredTool[]): void;
  /** Clear conversation history */
  clearHistory(): void;
}

export function createAgent(
  modelRouter: ModelRouter,
  systemPrompt: string,
  tools: RegisteredTool[],
): SysAdminAgent {
  let currentSystemPrompt = systemPrompt;
  let currentTools = tools;
  const messages: ChatMessage[] = [];

  function getToolDefinitions(): ToolDefinition[] {
    return currentTools.map((t) => t.definition);
  }

  function findToolHandler(name: string): RegisteredTool | undefined {
    return currentTools.find((t) => t.definition.name === name);
  }

  async function chat(message: string): Promise<AgentTurnResult> {
    messages.push({ role: 'user', content: message });

    const systemBlocks: SystemBlock[] = [{ type: 'text', text: currentSystemPrompt }];
    let stateTransition: AgentTurnResult['stateTransition'];

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await modelRouter.chat({
        role: 'agent',
        system: systemBlocks,
        tools: getToolDefinitions(),
        messages,
      });

      if (response.stopReason === 'end_turn') {
        const text = response.content
          .filter((b): b is ChatContentBlock & { type: 'text' } => b.type === 'text')
          .map((b) => b.text)
          .join('\n');

        return { response: text, stateTransition };
      }

      if (response.stopReason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.content });
        const toolResults: ChatContentBlock[] = [];

        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;

          log.info({ tool: block.name, input: block.input }, 'executing tool');
          const handler = findToolHandler(block.name);

          let result: ToolResult;
          if (handler) {
            try {
              result = await handler.handler(block.input as Record<string, unknown>);
              if (result.stateTransition) {
                stateTransition = result.stateTransition;
              }
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              log.error({ err, tool: block.name }, 'tool execution failed');
              result = { result: `Error: ${errorMsg}` };
            }
          } else {
            result = { result: `Unknown tool: ${block.name}` };
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result.result,
          });
        }

        messages.push({ role: 'user', content: toolResults });

        // If a tool triggered a state transition, break out of the loop
        if (stateTransition) {
          const text = response.content
            .filter((b): b is ChatContentBlock & { type: 'text' } => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
          return { response: text || 'State transition initiated.', stateTransition };
        }

        continue;
      }

      // Unexpected stop reason
      log.warn({ stopReason: response.stopReason }, 'unexpected stop reason');
      const text = response.content
        .filter((b): b is ChatContentBlock & { type: 'text' } => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      return { response: text || '(no response)', stateTransition };
    }

    return { response: 'Reached maximum tool-use iterations.', stateTransition };
  }

  function reconfigure(newSystemPrompt: string, newTools: RegisteredTool[]): void {
    currentSystemPrompt = newSystemPrompt;
    currentTools = newTools;
    log.info({ toolCount: newTools.length }, 'agent reconfigured');
  }

  function clearHistory(): void {
    messages.length = 0;
    log.info('conversation history cleared');
  }

  return { chat, reconfigure, clearHistory };
}
