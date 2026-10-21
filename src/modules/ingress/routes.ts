import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from '../../db/index.js';
import { findEndpoint } from '../endpoints/repository.js';
import { sendError } from '../http/errors.js';

const params = z.strictObject({ endpointId: z.uuid() });

export function registerIngressRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; bodyLimitBytes: number },
): void {
  void app.register(async (ingress) => {
    // Сырое тело нужно для HMAC (шаг 7): подпись считается по байтам, не по пересериализованному JSON.
    ingress.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (request, body, done) => {
        try {
          JSON.parse((body as Buffer).toString('utf8'));
          done(null, body);
        } catch {
          request.log.warn('invalid JSON in webhook body');
          done(Object.assign(new Error('Body is not valid JSON'), { statusCode: 400 }));
        }
      },
    );

    ingress.post<{ Params: { endpointId: string }; Body: Buffer }>(
      '/webhooks/:endpointId',
      { bodyLimit: deps.bodyLimitBytes },
      async (request, reply) => {
        const p = params.safeParse(request.params);
        if (!p.success) {
          return sendError(reply, 400, 'validation_error', 'endpointId must be a UUID');
        }
        if (!Buffer.isBuffer(request.body)) {
          return sendError(
            reply,
            415,
            'unsupported_media_type',
            'Content-Type must be application/json',
          );
        }
        const endpoint = await findEndpoint(deps.pool, p.data.endpointId);
        if (!endpoint?.is_active) {
          return sendError(reply, 404, 'not_found', 'Endpoint not found');
        }
        return reply.code(202).send({ status: 'accepted' });
      },
    );
  });
}
