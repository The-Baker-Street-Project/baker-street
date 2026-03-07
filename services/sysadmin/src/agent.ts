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
    let lastTextResponse = '';

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      let response;
      try {
        response = await modelRouter.chat({
          role: 'agent',
          system: systemBlocks,
          tools: getToolDefinitions(),
          messages,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log.error({ err }, 'model router chat failed');
        // On API error, return whatever we have so far rather than corrupting messages
        return {
          response: lastTextResponse || `Error communicating with AI: ${errorMsg}`,
          stateTransition,
        };
      }

      // Extract any text from the response
      const textParts = response.content
        .filter((b): b is ChatContentBlock & { type: 'text' } => b.type === 'text')
        .map((b) => b.text);
      if (textParts.length > 0) {
        lastTextResponse = textParts.join('\n');
      }

      if (response.stopReason === 'end_turn') {
        return { response: lastTextResponse, stateTransition };
      }

      if (response.stopReason === 'tool_use') {
        // Push assistant message first
        messages.push({ role: 'assistant', content: response.content });

        // ALWAYS process ALL tool_use blocks to produce matching tool_results.
        // Skipping any would corrupt the message history and cause API errors.
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

        // Push ALL tool results before checking state transition
        messages.push({ role: 'user', content: toolResults });

        // If a tool triggered a state transition, return after completing all results
        if (stateTransition) {
          return { response: lastTextResponse || 'State transition initiated.', stateTransition };
        }

        continue;
      }

      // Unexpected stop reason
      log.warn({ stopReason: response.stopReason }, 'unexpected stop reason');
      return { response: lastTextResponse || '(no response)', stateTransition };
    }

    return { response: lastTextResponse || 'Reached maximum tool-use iterations.', stateTransition };
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
