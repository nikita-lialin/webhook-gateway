import type { Pool } from '../../db/index.js';
import type { EndpointRow } from '../../db/types.js';

/** Эндпоинт без `signing_secret`: безопасен для ответов API и логов. */
export type PublicEndpoint = Omit<EndpointRow, 'signing_secret'>;

const PUBLIC_COLUMNS = 'id, name, source, target_url, is_active, created_at, updated_at';

export interface NewEndpoint {
  name: string;
  source: string;
  targetUrl: string;
  signingSecret: string;
}

export interface EndpointPatch {
  targetUrl?: string | undefined;
  isActive?: boolean | undefined;
}

export async function insertEndpoint(pool: Pool, input: NewEndpoint): Promise<PublicEndpoint> {
  const { rows } = await pool.query<PublicEndpoint>(
    `INSERT INTO endpoints (name, source, target_url, signing_secret)
     VALUES ($1, $2, $3, $4)
     RETURNING ${PUBLIC_COLUMNS}`,
    [input.name, input.source, input.targetUrl, input.signingSecret],
  );
  return rows[0] as PublicEndpoint;
}

export async function listEndpoints(pool: Pool): Promise<PublicEndpoint[]> {
  const { rows } = await pool.query<PublicEndpoint>(
    `SELECT ${PUBLIC_COLUMNS} FROM endpoints ORDER BY created_at DESC, id`,
  );
  return rows;
}

export async function findEndpoint(pool: Pool, id: string): Promise<PublicEndpoint | null> {
  const { rows } = await pool.query<PublicEndpoint>(
    `SELECT ${PUBLIC_COLUMNS} FROM endpoints WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Обновляет только переданные поля; `null`, если эндпоинта нет. */
export async function updateEndpoint(
  pool: Pool,
  id: string,
  patch: EndpointPatch,
): Promise<PublicEndpoint | null> {
  const { rows } = await pool.query<PublicEndpoint>(
    `UPDATE endpoints
        SET target_url = COALESCE($2, target_url),
            is_active  = COALESCE($3, is_active),
            updated_at = now()
      WHERE id = $1
      RETURNING ${PUBLIC_COLUMNS}`,
    [id, patch.targetUrl ?? null, patch.isActive ?? null],
  );
  return rows[0] ?? null;
}
