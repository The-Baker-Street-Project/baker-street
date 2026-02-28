import { logger } from '@bakerst/shared';
import type { RegisteredTool } from '../types.js';

const log = logger.child({ module: 'transitions' });

export function createTransitionTools(): RegisteredTool[] {
  return [
    {
      definition: {
        name: 'transition_to_runtime',
        description: 'Transition from deploy or update mode to runtime monitoring mode. Call this after the deployment is complete and all services are healthy.',
        input_schema: {
          type: 'object',
          properties: {
            deployedVersion: { type: 'string', description: 'The version that was just deployed' },
          },
        },
      },
      handler: async (input) => {
        const version = input.deployedVersion as string | undefined;
        log.info({ version }, 'transitioning to runtime mode');
        return {
          result: `Transitioning to runtime mode${version ? ` (version ${version})` : ''}.`,
          stateTransition: 'runtime' as const,
        };
      },
    },
    {
      definition: {
        name: 'transition_to_update',
        description: 'Transition from runtime mode to update mode. Call this when a new release is available and the user wants to update.',
        input_schema: {
          type: 'object',
          properties: {
            targetVersion: { type: 'string', description: 'The version to update to' },
          },
          required: ['targetVersion'],
        },
      },
      handler: async (input) => {
        const version = input.targetVersion as string;
        log.info({ version }, 'transitioning to update mode');
        return {
          result: `Transitioning to update mode (target: ${version}).`,
          stateTransition: 'update' as const,
        };
      },
    },
  ];
}
