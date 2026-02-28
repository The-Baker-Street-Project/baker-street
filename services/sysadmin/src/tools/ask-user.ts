import { logger } from '@bakerst/shared';
import { askUserViaWs, sendToTerminal } from '../api.js';
import type { RegisteredTool } from '../types.js';

const log = logger.child({ module: 'ask-user' });

export function createAskUserTools(): RegisteredTool[] {
  return [
    {
      definition: {
        name: 'ask_user',
        description: 'Ask the user a question and wait for their response. Use this to collect secrets, get confirmations, or offer choices during deployment.',
        input_schema: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question to ask' },
            inputType: {
              type: 'string',
              enum: ['text', 'secret', 'choice'],
              description: 'Input type: text (visible), secret (hidden), or choice (select from options)',
            },
            choices: {
              type: 'array',
              items: { type: 'string' },
              description: 'Available choices (required when inputType is "choice")',
            },
          },
          required: ['question', 'inputType'],
        },
      },
      handler: async (input) => {
        const question = input.question as string;
        const inputType = input.inputType as 'text' | 'secret' | 'choice';
        const choices = input.choices as string[] | undefined;

        log.info({ question, inputType }, 'asking user');

        try {
          const answer = await askUserViaWs(question, inputType, choices);
          log.info({ question, answered: true }, 'user answered');
          return { result: answer };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn({ err, question }, 'ask_user failed');
          sendToTerminal({ type: 'error', message: `Failed to get answer: ${msg}` });
          return { result: `No answer received: ${msg}` };
        }
      },
    },
  ];
}
