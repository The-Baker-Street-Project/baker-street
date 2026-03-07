import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { logger } from '@bakerst/shared';
import type { DoorPolicyManager } from './door-policy.js';

const log = logger.child({ module: 'admin-api' });

const ADMIN_PORT = 3001;

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function startAdminApi(doorPolicy: DoorPolicyManager): void {
  const authToken = process.env.AUTH_TOKEN;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${ADMIN_PORT}`);
    const method = req.method ?? 'GET';

    // Auth check (skip for health)
    if (url.pathname !== '/ping') {
      if (!authToken) {
        json(res, 503, { error: 'Admin API requires AUTH_TOKEN to be configured' });
        return;
      }

      const authHeader = req.headers.authorization ?? '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (!token || !safeCompare(token, authToken)) {
        json(res, 401, { error: 'Unauthorized' });
        return;
      }
    }

    try {
      // GET /ping — health check
      if (method === 'GET' && url.pathname === '/ping') {
        json(res, 200, { status: 'ok', mode: doorPolicy.getMode() });
        return;
      }

      // POST /pairing-codes — generate a new pairing code
      if (method === 'POST' && url.pathname === '/pairing-codes') {
        let platform: string | undefined;
        const body = await readBody(req);
        if (body) {
          try {
            const parsed = JSON.parse(body);
            platform = parsed.platform;
          } catch {
            // Empty or invalid JSON body is fine — platform is optional
          }
        }

        const code = doorPolicy.generatePairingCode(platform);
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        log.info({ code, platform: platform ?? 'any' }, 'pairing code generated via admin API');
        json(res, 201, { code, expiresAt });
        return;
      }

      // GET /approved-senders — list all approved senders
      if (method === 'GET' && url.pathname === '/approved-senders') {
        const senders = doorPolicy.listApproved();
        json(res, 200, { senders });
        return;
      }

      // DELETE /approved-senders/:platform/:senderId — revoke a sender
      const revokeMatch = url.pathname.match(/^\/approved-senders\/([^/]+)\/([^/]+)$/);
      if (method === 'DELETE' && revokeMatch) {
        const platform = decodeURIComponent(revokeMatch[1]);
        const senderId = decodeURIComponent(revokeMatch[2]);
        const revoked = doorPolicy.revokeSender(platform, senderId);
        if (revoked) {
          json(res, 200, { message: 'Sender revoked', platform, senderId });
        } else {
          json(res, 404, { error: 'Sender not found' });
        }
        return;
      }

      // Not found
      json(res, 404, { error: 'Not found' });
    } catch (err) {
      log.error({ err }, 'admin API error');
      const message = err instanceof Error ? err.message : 'Internal server error';
      json(res, 500, { error: message });
    }
  });

  server.listen(ADMIN_PORT, () => {
    log.info({ port: ADMIN_PORT }, 'admin API started');
  });
}
