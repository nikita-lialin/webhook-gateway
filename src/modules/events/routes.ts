import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from '../../db/index.js';
import { EVENT_STATUSES } from '../../db/types.js';
import { createAdminAuth } from '../endpoints/auth.js';
import { sendError } from '../http/errors.js';
import { enqueueReplay, type DeliveryQueue } from '../../queue/index.js';
import { findEndpoint } from '../endpoints/repository.js';
import {
  findEvent,
  listAttempts,
  listEvents,
  startReplay,
  type EventCursor,
} from './repository.js';

const idParams = z.strictObject({ id: z.uuid() });

const isoDate = z.iso.datetime({ offset: true });

const listQuery = z.strictObject({
  status: z.enum(EVENT_STATUSES).optional(),
  endpointId: z.uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(512).optional(),
});

const cursorSchema = z.strictObject({
  c: z.iso.datetime({ precision: 6 }),
  i: z.uuid(),
});

export function encodeCursor(cursor: EventCursor): string {
  return Buffer.from(JSON.stringify({ c: cursor.createdAt, i: cursor.id })).toString('base64url');
}

export function decodeCursor(raw: string): EventCursor | null {
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(raw, 'base64url').toString()));
    return parsed.success ? { createdAt: parsed.data.c, id: parsed.data.i } : null;
  } catch {
    return null;
  }
}

export function registerEventRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; queue: DeliveryQueue; adminApiKey: string },
): void {
  const { pool } = deps;

  void app.register(async (admin) => {
    admin.addHook('onRequest', createAdminAuth(deps.adminApiKey));

    admin.get('/events', async (request, reply) => {
      const query = listQuery.safeParse(request.query);
      if (!query.success) return invalid(reply, query.error);
      const { cursor: rawCursor, limit, ...filter } = query.data;
      let cursor: EventCursor | null = null;
      if (rawCursor !== undefined) {
        cursor = decodeCursor(rawCursor);
        if (!cursor) return sendError(reply, 400, 'validation_error', 'cursor: invalid cursor');
      }
      const page = await listEvents(pool, filter, limit, cursor);
      return {
        items: page.items,
        next_cursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
      };
    });

    admin.get('/events/:id', async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return invalid(reply, params.error);
      const event = await findEvent(pool, params.data.id);
      return event ?? sendError(reply, 404, 'not_found', 'Event not found');
    });

    admin.post('/events/:id/replay', async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return invalid(reply, params.error);
      const { id } = params.data;
      const replayNumber = await startReplay(pool, id);
      if (replayNumber === null) {
        const event = await findEvent(pool, id);
        if (!event) return sendError(reply, 404, 'not_found', 'Event not found');
        const endpoint = await findEndpoint(pool, event.endpoint_id);
        if (endpoint && !endpoint.is_active) {
          return sendError(reply, 409, 'conflict', 'Endpoint is disabled');
        }
        return sendError(
          reply,
          409,
          'conflict',
          `Event in status "${event.status}" cannot be replayed`,
        );
      }
      // Событие уже pending в БД: сбой очереди не ломает ответ, его подберёт recovery sweeper.
      try {
        await enqueueReplay(deps.queue, id, replayNumber);
      } catch (err) {
        request.log.error({ err, eventId: id }, 'failed to enqueue replay; event stays pending');
      }
      request.log.info({ eventId: id, replay: replayNumber }, 'event replay started');
      return reply.code(202).send({ eventId: id, status: 'pending', replay: replayNumber });
    });

    admin.get('/events/:id/attempts', async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return invalid(reply, params.error);
      if (!(await findEvent(pool, params.data.id))) {
        return sendError(reply, 404, 'not_found', 'Event not found');
      }
      return { items: await listAttempts(pool, params.data.id) };
    });
  });
}

function invalid(reply: Parameters<typeof sendError>[0], error: z.ZodError) {
  const message = error.issues
    .map((i) => `${i.path.join('.') || 'request'}: ${i.message}`)
    .join('; ');
  return sendError(reply, 400, 'validation_error', message);
}
