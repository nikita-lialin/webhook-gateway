import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Pool } from '../../db/index.js';
import { createAdminAuth } from './auth.js';
import { findEndpoint, insertEndpoint, listEndpoints, updateEndpoint } from './repository.js';

const targetUrl = z.url({ protocol: /^https?$/ });

const createBody = z.strictObject({
  name: z.string().trim().min(1).max(200),
  source: z.string().trim().min(1).max(200),
  target_url: targetUrl.max(2048),
});

const patchBody = z
  .strictObject({
    target_url: targetUrl.max(2048).optional(),
    is_active: z.boolean().optional(),
  })
  .refine((b) => b.target_url !== undefined || b.is_active !== undefined, {
    message: 'At least one of target_url, is_active is required',
  });

const idParams = z.strictObject({ id: z.uuid() });

function badRequest(reply: FastifyReply, error: z.ZodError): FastifyReply {
  const message = error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
  return reply.code(400).send({ error: { code: 'validation_error', message } });
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: { code: 'not_found', message: 'Endpoint not found' } });
}

export function registerEndpointRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; adminApiKey: string },
): void {
  const { pool } = deps;

  void app.register(async (admin) => {
    admin.addHook('onRequest', createAdminAuth(deps.adminApiKey));

    admin.post('/endpoints', async (request, reply) => {
      const body = createBody.safeParse(request.body);
      if (!body.success) return badRequest(reply, body.error);
      const signingSecret = randomBytes(32).toString('hex');
      const endpoint = await insertEndpoint(pool, {
        name: body.data.name,
        source: body.data.source,
        targetUrl: body.data.target_url,
        signingSecret,
      });
      // Единственный раз, когда секрет покидает сервер.
      return reply.code(201).send({ ...endpoint, signing_secret: signingSecret });
    });

    admin.get('/endpoints', async () => ({ items: await listEndpoints(pool) }));

    admin.get('/endpoints/:id', async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return badRequest(reply, params.error);
      const endpoint = await findEndpoint(pool, params.data.id);
      return endpoint ?? notFound(reply);
    });

    admin.patch('/endpoints/:id', async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return badRequest(reply, params.error);
      const body = patchBody.safeParse(request.body);
      if (!body.success) return badRequest(reply, body.error);
      const endpoint = await updateEndpoint(pool, params.data.id, {
        targetUrl: body.data.target_url,
        isActive: body.data.is_active,
      });
      return endpoint ?? notFound(reply);
    });
  });
}
