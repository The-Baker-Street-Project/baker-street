import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '@bakerst/shared';
import type { RegisteredTool } from '../types.js';

const execFileAsync = promisify(execFile);
const log = logger.child({ module: 'verify-integrity' });

const COSIGN_IDENTITY = process.env.COSIGN_IDENTITY_REGEXP
  ?? 'github.com/The-Baker-Street-Project/baker-street';
const COSIGN_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

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
  ];
}
