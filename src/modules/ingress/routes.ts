import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from '../../db/index.js';
import { findEndpoint } from '../endpoints/repository.js';
import { sendError } from '../http/errors.js';
import { verifySignature } from './signature.js';

const params = z.strictObject({ endpointId: z.uuid() });

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function registerIngressRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; bodyLimitBytes: number; webhookSecret: string },
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
      {
        bodyLimit: deps.bodyLimitBytes,
        preHandler: async (request, reply) => {
          // Не-Buffer тело (нет Content-Type) отклоняет обработчик с 415.
          if (!Buffer.isBuffer(request.body)) return;
          const result = verifySignature(
            request.body,
            singleHeader(request.headers['x-webhook-timestamp']),
            singleHeader(request.headers['x-webhook-signature']),
            deps.webhookSecret,
            Date.now(),
          );
          if (!result.ok) {
            request.log.warn({ reason: result.reason }, 'webhook signature rejected');
            return sendError(reply, 401, 'unauthorized', 'Invalid signature');
          }
        },
      },
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
