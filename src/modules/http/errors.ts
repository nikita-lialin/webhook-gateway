import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';

export interface ErrorBody {
  error: { code: string; message: string };
}

export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  const body: ErrorBody = { error: { code, message } };
  return reply.code(status).send(body);
}

const CODES: Record<number, string> = {
  400: 'bad_request',
  404: 'not_found',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
};

/** Единый формат ошибок `{ error: { code, message } }`; 5xx не раскрывают детали клиенту. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, request, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err }, 'request failed');
      return sendError(reply, 500, 'internal_error', 'Internal server error');
    }
    request.log.warn({ err }, 'request rejected');
    return sendError(reply, status, CODES[status] ?? 'bad_request', err.message);
  });

  app.setNotFoundHandler((_request, reply) =>
    sendError(reply, 404, 'not_found', 'Route not found'),
  );
}
