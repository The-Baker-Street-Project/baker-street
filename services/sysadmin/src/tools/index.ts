import type { RegisteredTool } from '../types.js';
import { createK8sCoreTools } from './k8s-core.js';
import { createK8sDeployTools } from './k8s-deploy.js';
import { createK8sHealthTools } from './k8s-health.js';
import { createVerifyIntegrityTools } from './verify-integrity.js';
import { createReleaseManifestTools } from './release-manifest.js';
import { createAskUserTools } from './ask-user.js';
import { createTransitionTools } from './transitions.js';

/**
 * Create all available tools. The tool-registry filters these by state.
 */
export function createAllTools(): RegisteredTool[] {
  return [
    ...createK8sCoreTools(),
    ...createK8sDeployTools(),
    ...createK8sHealthTools(),
    ...createVerifyIntegrityTools(),
    ...createReleaseManifestTools(),
    ...createAskUserTools(),
    ...createTransitionTools(),
  ];
}
