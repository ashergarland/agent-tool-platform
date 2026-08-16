import { z } from 'zod';
import { assessSecretStrength, minimumSecretBits } from '../auth/credentials.js';

/**
 * Platform base configuration.
 *
 * There is deliberately no universal `AppConfig` that knows about every capability. This module
 * owns the concerns every hosted tool server shares — service identity, HTTP transport, auth mode,
 * logging, and the generic mutation gate — and nothing else. A capability extends it through
 * {@link defineCapabilityConfig} in `./capability.js`.
 *
 * Environment parsing rules are seeded by the AST Summarizer configuration module: blank values
 * are normalized away so an empty environment variable behaves like an unset one, CSV lists are
 * parsed uniformly, and booleans are strict rather than truthy.
 */

export class ConfigurationError extends Error {
  public override readonly name = 'ConfigurationError';
}

/** Treats an empty or whitespace-only variable as unset so a blank value never defeats a default. */
export const withoutBlankValues = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(source).filter(([, value]) => value === undefined || value.trim() !== ''),
  );

export const csvList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().min(1)))
  .catch([] as string[]);

/** Strict boolean parsing: an unrecognized value is a configuration error, not `false`. */
export const strictBoolean = z.union([z.boolean(), z.string()]).transform((value, context) => {
  if (typeof value === 'boolean') return value;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  context.addIssue({ code: 'custom', message: 'Expected a boolean value' });
  return z.NEVER;
});

export const positiveInteger = (fallback: number): z.ZodDefault<z.ZodCoercedNumber> =>
  z.coerce.number().int().min(1).default(fallback);

/**
 * `trustProxy` mirrors Fastify's own option: a boolean, a hop count, or a CSV of trusted
 * addresses/CIDRs. Parsing it here keeps the HTTP layer free of environment concerns.
 */
const trustProxySchema = z
  .string()
  .default('false')
  .transform((value): boolean | number | string[] => {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    const hops = Number.parseInt(normalized, 10);
    if (String(hops) === normalized && hops >= 0) return hops;
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  });

export const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export const platformEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  LOG_LEVEL: z.enum(logLevels).default('info'),

  SERVICE_NAME: z.string().min(1).optional(),
  SERVICE_VERSION: z.string().min(1).optional(),
  GIT_SHA: z.string().min(1).default('unknown'),
  PUBLIC_BASE_URL: z.url().optional(),

  BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).max(64_000_000).default(1_000_000),
  TRUST_PROXY: trustProxySchema,
  RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(120),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  PRE_AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(30),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(120_000).default(10_000),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(0).max(600_000).default(0),

  AUTH_MODE: z.enum(['api-key', 'entra-jwt', 'disabled']).default('api-key'),
  API_KEYS: csvList.default([]),
  ENTRA_TENANT_ID: z.string().min(1).optional(),
  ENTRA_AUDIENCE: z.string().min(1).optional(),
  ENTRA_ALLOWED_APP_IDS: csvList.default([]),
  ENTRA_CLOCK_TOLERANCE_SECONDS: z.coerce.number().int().min(0).max(600).default(60),
  ENTRA_JWKS_URI: z.url().optional(),

  MUTATIONS_ENABLED: strictBoolean.default(false),
  MUTATION_CONFIRMATION_REQUIRED: strictBoolean.default(true),
});

export type PlatformEnv = z.infer<typeof platformEnvSchema>;

export type LogLevel = (typeof logLevels)[number];

export type AuthConfig =
  | { readonly mode: 'disabled' }
  | { readonly mode: 'api-key'; readonly apiKeys: readonly string[] }
  | {
      readonly mode: 'entra-jwt';
      readonly tenantId: string;
      readonly audience: string;
      readonly allowedAppIds: readonly string[];
      readonly clockToleranceSeconds: number;
      readonly jwksUri: string | undefined;
    };

export interface PlatformConfig {
  readonly env: PlatformEnv['NODE_ENV'];
  readonly isProduction: boolean;
  readonly service: {
    readonly name: string;
    readonly version: string;
    readonly gitSha: string;
    readonly publicBaseUrl: string | undefined;
  };
  readonly http: {
    readonly host: string;
    readonly port: number;
    readonly bodyLimit: number;
    readonly trustProxy: boolean | number | string[];
    readonly rateLimit: { readonly max: number; readonly windowMs: number };
    readonly preAuthRateLimitMax: number;
    readonly shutdownGraceMs: number;
    /** Zero disables the platform-level per-request deadline. */
    readonly requestTimeoutMs: number;
  };
  readonly auth: AuthConfig;
  readonly logging: { readonly level: LogLevel };
  readonly mutations: {
    readonly enabled: boolean;
    readonly confirmationRequired: boolean;
  };
}

export interface PlatformConfigDefaults {
  readonly serviceName: string;
  readonly serviceVersion: string;
}

const describeWeakSecret = (reason: string | undefined): string => {
  if (reason === 'too_short') return 'it must be at least 32 characters';
  if (reason === 'repetitive') return 'it repeats a short pattern';
  return `its estimated entropy is below ${minimumSecretBits} bits`;
};

const buildAuthConfig = (env: PlatformEnv): AuthConfig => {
  if (env.AUTH_MODE === 'disabled') {
    // Local stdio and development runs may legitimately have no credential, but a hosted
    // deployment that forgets to configure one must fail closed rather than serve anonymously.
    if (env.NODE_ENV === 'production') {
      throw new ConfigurationError('AUTH_MODE=disabled is not permitted in production');
    }
    return { mode: 'disabled' };
  }

  if (env.AUTH_MODE === 'entra-jwt') {
    if (!env.ENTRA_TENANT_ID) {
      throw new ConfigurationError('AUTH_MODE=entra-jwt requires ENTRA_TENANT_ID');
    }
    if (!env.ENTRA_AUDIENCE) {
      throw new ConfigurationError('AUTH_MODE=entra-jwt requires ENTRA_AUDIENCE');
    }
    return {
      mode: 'entra-jwt',
      tenantId: env.ENTRA_TENANT_ID,
      audience: env.ENTRA_AUDIENCE,
      allowedAppIds: env.ENTRA_ALLOWED_APP_IDS,
      clockToleranceSeconds: env.ENTRA_CLOCK_TOLERANCE_SECONDS,
      jwksUri: env.ENTRA_JWKS_URI,
    };
  }

  if (env.API_KEYS.length === 0) {
    throw new ConfigurationError('AUTH_MODE=api-key requires API_KEYS');
  }
  // Keys are verified with a fast keyed hash, which is only sound for high-entropy tokens.
  for (const key of env.API_KEYS) {
    const strength = assessSecretStrength(key);
    if (strength.acceptable) continue;
    throw new ConfigurationError(
      `Every API key must be a randomly generated token, but ${describeWeakSecret(
        strength.reason,
      )}. Generate one with: openssl rand -hex 32`,
    );
  }
  return { mode: 'api-key', apiKeys: env.API_KEYS };
};

export const buildPlatformConfig = (
  env: PlatformEnv,
  defaults: PlatformConfigDefaults,
): PlatformConfig => ({
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  service: {
    name: env.SERVICE_NAME ?? defaults.serviceName,
    version: env.SERVICE_VERSION ?? defaults.serviceVersion,
    gitSha: env.GIT_SHA,
    publicBaseUrl: env.PUBLIC_BASE_URL,
  },
  http: {
    host: env.HOST,
    port: env.PORT,
    bodyLimit: env.BODY_LIMIT_BYTES,
    trustProxy: env.TRUST_PROXY,
    rateLimit: { max: env.RATE_LIMIT_MAX, windowMs: env.RATE_LIMIT_WINDOW_MS },
    preAuthRateLimitMax: env.PRE_AUTH_RATE_LIMIT_MAX,
    shutdownGraceMs: env.SHUTDOWN_GRACE_MS,
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
  },
  auth: buildAuthConfig(env),
  logging: { level: env.LOG_LEVEL },
  mutations: {
    enabled: env.MUTATIONS_ENABLED,
    confirmationRequired: env.MUTATION_CONFIRMATION_REQUIRED,
  },
});

export const formatIssues = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');

export const parsePlatformEnv = (source: NodeJS.ProcessEnv): PlatformEnv => {
  const parsed = platformEnvSchema.safeParse(withoutBlankValues(source));
  if (!parsed.success) {
    throw new ConfigurationError(
      `Invalid environment configuration: ${formatIssues(parsed.error)}`,
    );
  }
  return parsed.data;
};

/** Convenience for tests and for capabilities that need only the platform surface. */
export const loadPlatformConfig = (
  defaults: PlatformConfigDefaults,
  source: NodeJS.ProcessEnv = process.env,
): PlatformConfig => buildPlatformConfig(parsePlatformEnv(source), defaults);
