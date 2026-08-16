import type { PlatformConfig } from '../config/platform.js';
import { redactServerError, toAppError } from '../errors.js';
import type { HttpServer } from './types.js';

/**
 * One error handler for every route, including capability extension routes.
 *
 * In production a 5xx loses its message before it is sent: an unexpected exception may embed a
 * path, a connection string, or provider detail. The full error is still logged server-side.
 */
export const registerErrorHandler = (app: HttpServer, config: PlatformConfig): void => {
  app.setErrorHandler((error, request, reply) => {
    const appError = toAppError(error);
    const safe = config.isProduction ? redactServerError(appError) : appError;

    if (appError.statusCode >= 500) {
      request.log.error(
        { err: error, event: 'request.error', errorCode: appError.code },
        'unhandled request failure',
      );
    }

    void reply.status(appError.statusCode).send({ error: safe.toPayload(String(request.id)) });
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: {
        code: 'not_found' as const,
        message: 'Unknown route',
        retryable: false,
        requestId: String(request.id),
      },
    });
  });
};
