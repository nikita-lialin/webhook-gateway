import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from '../../db/index.js';
import { enqueueDelivery, type DeliveryQueue } from '../../queue/index.js';
import { findEndpoint } from '../endpoints/repository.js';
import { insertEventIdempotent } from '../events/repository.js';
import { sendError } from '../http/errors.js';
import { verifySignature } from './signature.js';

const params = z.strictObject({ endpointId: z.uuid() });

const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

// Только безопасные заголовки: без подписи, Authorization и cookie.
const STORED_HEADERS = [
  'content-type',
  'user-agent',
  'idempotency-key',
  'x-request-id',
  'x-webhook-timestamp',
] as const;

function pickStoredHeaders(headers: Record<string, string | string[] | undefined>) {
  const picked: Record<string, string> = {};
  for (const name of STORED_HEADERS) {
    const value = headers[name];
    if (typeof value === 'string') picked[name] = value;
  }
  return picked;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function registerIngressRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; queue: DeliveryQueue; bodyLimitBytes: number; webhookSecret: string },
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
        let endpoint;
        try {
          endpoint = await findEndpoint(deps.pool, p.data.endpointId);
        } catch (err) {
          request.log.error({ err }, 'failed to load endpoint');
          return sendError(reply, 503, 'service_unavailable', 'Temporarily unable to store event');
        }
        if (!endpoint?.is_active) {
          return sendError(reply, 404, 'not_found', 'Endpoint not found');
        }

        const rawKey = singleHeader(request.headers['idempotency-key'])?.trim();
        if (request.headers['idempotency-key'] !== undefined && !rawKey) {
          return sendError(reply, 400, 'validation_error', 'Idempotency-Key must not be empty');
        }
        if (rawKey && rawKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
          return sendError(reply, 400, 'validation_error', 'Idempotency-Key is too long');
        }
        const idempotencyKey = rawKey ?? createHash('sha256').update(request.body).digest('hex');

        let eventId: string;
        try {
          const saved = await insertEventIdempotent(deps.pool, {
            endpointId: endpoint.id,
            idempotencyKey,
            payloadJson: request.body.toString('utf8'),
            headers: pickStoredHeaders(request.headers),
          });
          if (saved.duplicate) {
            return reply.code(200).send({ eventId: saved.eventId, duplicate: true });
          }
          eventId = saved.eventId;
        } catch (err) {
          request.log.error({ err, endpointId: endpoint.id }, 'failed to store event');
          return sendError(reply, 503, 'service_unavailable', 'Temporarily unable to store event');
        }

        // Событие уже в БД: сбой очереди не ломает ответ, событие остаётся pending (подберёт шаг 14).
        try {
          await enqueueDelivery(deps.queue, eventId);
        } catch (err) {
          request.log.error({ err, eventId }, 'failed to enqueue delivery; event stays pending');
        }
        return reply.code(202).send({ eventId });
      },
    );
  });
}
