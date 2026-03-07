import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as k8s from '@kubernetes/client-node';
import { logger } from '@bakerst/shared';
import type { RegisteredTool } from '../types.js';
import { getCachedManifest } from './release-manifest.js';

const execFileAsync = promisify(execFile);
const log = logger.child({ module: 'verify-integrity' });

const NAMESPACE = process.env.NAMESPACE ?? 'bakerst';
const COSIGN_IDENTITY = process.env.COSIGN_IDENTITY_REGEXP
  ?? 'github.com/The-Baker-Street-Project/baker-street';
const COSIGN_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

let coreApi: k8s.CoreV1Api;

function getCoreApi(): k8s.CoreV1Api {
  if (!coreApi) {
    const kc = new k8s.KubeConfig();
    kc.loadFromCluster();
    coreApi = kc.makeApiClient(k8s.CoreV1Api);
  }
  return coreApi;
}

/**
 * Extract the digest portion from a K8s imageID.
 * K8s stores imageID as "docker-pullable://ghcr.io/org/image@sha256:abc..."
 * or just "ghcr.io/org/image@sha256:abc..."
 */
function extractDigest(imageID: string): string | undefined {
  const match = imageID.match(/@(sha256:[a-f0-9]+)/);
  return match?.[1];
}

export function createVerifyIntegrityTools(): RegisteredTool[] {
  return [
    {
      definition: {
        name: 'verify_image_integrity',
        description: 'Verify a container image signature using cosign. Checks that the image was signed by the GitHub Actions workflow.',
        input_schema: {
          type: 'object',
          properties: {
            image: { type: 'string', description: 'Full image reference (e.g., ghcr.io/the-baker-street-project/bakerst-brain@sha256:abc...)' },
          },
          required: ['image'],
        },
      },
      handler: async (input) => {
        const image = input.image as string;

        try {
          const { stdout, stderr } = await execFileAsync('cosign', [
            'verify',
            '--certificate-identity-regexp', COSIGN_IDENTITY,
            '--certificate-oidc-issuer', COSIGN_OIDC_ISSUER,
            image,
          ], { timeout: 30_000 });

          log.info({ image }, 'image signature verified');
          return { result: `Image "${image}" signature verified.\n${stdout}${stderr}` };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn({ image, err }, 'image signature verification failed');
          return { result: `Image signature verification FAILED for "${image}": ${msg}` };
        }
      },
    },
    {
      definition: {
        name: 'verify_running_digests',
        description:
          'Compare the digests of all running Baker Street container images against the known-good digests ' +
          'from the release manifest. This is a fast, K8s-API-only check that detects image tampering or ' +
          'unexpected image swaps without needing to contact an external registry.',
        input_schema: {
          type: 'object',
          properties: {
            namespace: { type: 'string', description: 'Namespace (default: bakerst)' },
          },
        },
      },
      handler: async (input) => {
        const ns = (input.namespace as string) ?? NAMESPACE;
        const manifest = getCachedManifest();

        if (!manifest) {
          return { result: 'No release manifest cached. Fetch the manifest first with fetch_release_manifest.' };
        }

        // Build a lookup: image tag → expected digest
        const expectedDigests = new Map<string, string>();
        for (const img of manifest.images) {
          if (img.digest) {
            // Map both the full image:tag and just the component name
            expectedDigests.set(img.image, img.digest);
            expectedDigests.set(img.component, img.digest);
          }
        }

        if (expectedDigests.size === 0) {
          return { result: 'Release manifest has no digests to verify against.' };
        }

        // List all pods in the namespace
        const pods = await getCoreApi().listNamespacedPod({ namespace: ns });

        const results: Array<{
          pod: string;
          container: string;
          image: string;
          status: 'match' | 'mismatch' | 'unknown';
          runningDigest?: string;
          expectedDigest?: string;
        }> = [];

        for (const pod of pods.items) {
          const podName = pod.metadata?.name ?? 'unknown';
          const containerStatuses = pod.status?.containerStatuses ?? [];

          for (const cs of containerStatuses) {
            const runningDigest = cs.imageID ? extractDigest(cs.imageID) : undefined;
            const imageName = cs.image ?? '';

            // Try to find the expected digest by matching the image reference
            let expected: string | undefined;
            for (const [key, digest] of expectedDigests) {
              if (imageName.includes(key) || imageName.startsWith(key)) {
                expected = digest;
                break;
              }
            }

            if (!expected) {
              // Not a Baker Street image (e.g., nats, qdrant) — skip
              continue;
            }

            if (!runningDigest) {
              results.push({
                pod: podName,
                container: cs.name,
                image: imageName,
                status: 'unknown',
                expectedDigest: expected,
              });
            } else if (runningDigest === expected) {
              results.push({
                pod: podName,
                container: cs.name,
                image: imageName,
                status: 'match',
                runningDigest,
                expectedDigest: expected,
              });
            } else {
              results.push({
                pod: podName,
                container: cs.name,
                image: imageName,
                status: 'mismatch',
                runningDigest,
                expectedDigest: expected,
              });
            }
          }
        }

        const mismatches = results.filter((r) => r.status === 'mismatch');
        const unknowns = results.filter((r) => r.status === 'unknown');
        const matches = results.filter((r) => r.status === 'match');

        let summary = `Digest verification: ${matches.length} matched, ${mismatches.length} mismatched, ${unknowns.length} unknown.\n`;

        if (mismatches.length > 0) {
          summary += '\nMISMATCHES (potential tampering):\n';
          for (const m of mismatches) {
            summary += `  ${m.pod}/${m.container}: ${m.image}\n`;
            summary += `    running:  ${m.runningDigest}\n`;
            summary += `    expected: ${m.expectedDigest}\n`;
          }
        }

        if (unknowns.length > 0) {
          summary += '\nUNKNOWN (no running digest available):\n';
          for (const u of unknowns) {
            summary += `  ${u.pod}/${u.container}: ${u.image}\n`;
          }
        }

        if (mismatches.length > 0) {
          log.warn({ mismatches: mismatches.length }, 'image digest mismatches detected');
        } else {
          log.info({ matched: matches.length }, 'all image digests verified');
        }

        return { result: summary.trim() };
      },
    },
  ];
}
