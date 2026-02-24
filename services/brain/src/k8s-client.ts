/**
 * K8s client — delegates to @bakerst/core's K8sSecretClient.
 *
 * Brain-specific module that re-exports the core implementation.
 * Enterprise deployments can swap createK8sSecretClient for a Vault-backed client.
 */

import { createK8sSecretClient, type SecretData } from '@bakerst/core';

export type { SecretData };

const client = createK8sSecretClient('bakerst-secrets');

export const getSecrets = client.getSecrets.bind(client);
export const updateSecrets = client.updateSecrets.bind(client);
export const restartDeployment = client.restartDeployment.bind(client);
