import type {
  FastifyInstance,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { Logger } from 'pino';
import type { AuthenticationRequest, Principal } from '../auth/types.js';

/**
 * Supplying a concrete Pino logger to Fastify specializes the instance type, so the alias has to
 * name that specialization or every route registration fails to line up.
 */
export type HttpServer = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  Logger
>;

/**
 * The encapsulated scope handed to a capability route registrar. Fastify erases the concrete
 * logger type inside a plugin scope, so this is the default instance shape rather than
 * {@link HttpServer}.
 */
export type HttpRouter = FastifyInstance;

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

/**
 * Adapts a Fastify request to the transport-neutral authentication view, which is what keeps the
 * `Authenticator` contract free of any HTTP framework.
 */
export const toAuthenticationRequest = (request: FastifyRequest): AuthenticationRequest => ({
  header: (name) => {
    const raw = request.headers[name.toLowerCase()];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  },
});
