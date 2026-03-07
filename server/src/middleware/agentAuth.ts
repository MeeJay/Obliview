import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';

/**
 * Validates the X-API-Key header for agent push requests.
 * Attaches the api key id to req for downstream use.
 */
export async function agentAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const apiKey = req.headers['x-api-key'] as string | undefined;

  if (!apiKey) {
    res.status(401).json({ status: 'unauthorized' });
    return;
  }

  const keyRow = await db('agent_api_keys').where({ key: apiKey }).first();

  if (!keyRow) {
    res.status(401).json({ status: 'unauthorized' });
    return;
  }

  // Update last_used_at (fire and forget)
  db('agent_api_keys')
    .where({ id: keyRow.id })
    .update({ last_used_at: new Date() })
    .catch(() => {});

  (req as Request & { agentApiKeyId: number; agentTenantId: number }).agentApiKeyId = keyRow.id;
  (req as Request & { agentApiKeyId: number; agentTenantId: number }).agentTenantId = keyRow.tenant_id;
  next();
}
