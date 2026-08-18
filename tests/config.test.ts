import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  buildPlatformConfig,
  csvList,
  loadCapabilityConfig,
  parsePlatformEnv,
  strictBoolean,
  withoutBlankValues,
} from '@agent-tool-platform/runtime';
import { minimalConfig, type MinimalConfig } from '@agent-tool-platform/example-minimal-capability';
import { generateTestApiKey } from '@agent-tool-platform/testkit';

const defaults = { serviceName: 'platform-test', serviceVersion: '0.0.0-test' };
const baseEnv = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  AUTH_MODE: 'api-key',
  API_KEYS: generateTestApiKey(),
});

const load = (env: NodeJS.ProcessEnv): MinimalConfig =>
  loadCapabilityConfig<MinimalConfig>({ defaults, spec: minimalConfig, source: env });

describe('platform configuration', () => {
  it('normalizes blank values away', () => {
    expect(withoutBlankValues({ A: '', B: '  ', C: 'x', D: undefined })).toEqual({
      C: 'x',
      D: undefined,
    });
    expect(
      buildPlatformConfig(parsePlatformEnv({ ...baseEnv(), HOST: '  ' }), defaults).http.host,
    ).toBe('0.0.0.0');
  });

  it('parses CSV lists and strict booleans', () => {
    expect(csvList.parse(' a , b ,, c ')).toEqual(['a', 'b', 'c']);
    expect(strictBoolean.parse('ON')).toBe(true);
    expect(strictBoolean.parse('off')).toBe(false);
    expect(strictBoolean.safeParse('perhaps').success).toBe(false);
  });

  it('parses trust-proxy as a boolean, a hop count, or an address list', () => {
    const build = (value: string): unknown =>
      buildPlatformConfig(parsePlatformEnv({ ...baseEnv(), TRUST_PROXY: value }), defaults).http
        .trustProxy;
    expect(build('true')).toBe(true);
    expect(build('false')).toBe(false);
    expect(build('2')).toBe(2);
    expect(build('10.0.0.1, 10.0.0.2')).toEqual(['10.0.0.1', '10.0.0.2']);
  });

  it('supplies the documented HTTP defaults', () => {
    const config = buildPlatformConfig(parsePlatformEnv(baseEnv()), defaults);
    expect(config.http).toMatchObject({
      host: '0.0.0.0',
      port: 8080,
      bodyLimit: 1_000_000,
      preAuthRateLimitMax: 30,
      shutdownGraceMs: 10_000,
    });
    expect(config.http.rateLimit).toEqual({ max: 120, windowMs: 60_000 });
    expect(config.logging.level).toBe('info');
    expect(config.mutations).toEqual({ enabled: false, confirmationRequired: true });
  });

  it('refuses disabled auth in production but allows it locally', () => {
    expect(() =>
      buildPlatformConfig(
        parsePlatformEnv({ NODE_ENV: 'production', AUTH_MODE: 'disabled' }),
        defaults,
      ),
    ).toThrow(ConfigurationError);
    expect(
      buildPlatformConfig(
        parsePlatformEnv({ NODE_ENV: 'development', AUTH_MODE: 'disabled' }),
        defaults,
      ).auth.mode,
    ).toBe('disabled');
  });

  it('requires credentials that a fast keyed hash can protect', () => {
    expect(() =>
      buildPlatformConfig(
        parsePlatformEnv({ NODE_ENV: 'test', AUTH_MODE: 'api-key', API_KEYS: 'weak-key' }),
        defaults,
      ),
    ).toThrow(/randomly generated token/u);
    expect(() =>
      buildPlatformConfig(
        parsePlatformEnv({ NODE_ENV: 'test', AUTH_MODE: 'api-key', API_KEYS: '' }),
        defaults,
      ),
    ).toThrow(/requires API_KEYS/u);
  });

  it('requires the Entra tenant and audience when that mode is selected', () => {
    expect(() =>
      buildPlatformConfig(parsePlatformEnv({ NODE_ENV: 'test', AUTH_MODE: 'entra-jwt' }), defaults),
    ).toThrow(/ENTRA_TENANT_ID/u);
    expect(() =>
      buildPlatformConfig(
        parsePlatformEnv({
          NODE_ENV: 'test',
          AUTH_MODE: 'entra-jwt',
          ENTRA_TENANT_ID: 'tenant',
        }),
        defaults,
      ),
    ).toThrow(/ENTRA_AUDIENCE/u);

    const config = buildPlatformConfig(
      parsePlatformEnv({
        NODE_ENV: 'test',
        AUTH_MODE: 'entra-jwt',
        ENTRA_TENANT_ID: 'tenant',
        ENTRA_AUDIENCE: 'api://x',
        ENTRA_ALLOWED_APP_IDS: 'a,b',
      }),
      defaults,
    );
    expect(config.auth).toMatchObject({ mode: 'entra-jwt', allowedAppIds: ['a', 'b'] });
  });

  it('reports every invalid variable at once', () => {
    expect(() => parsePlatformEnv({ PORT: 'not-a-port', LOG_LEVEL: 'chatty' })).toThrow(
      /PORT.*LOG_LEVEL|LOG_LEVEL.*PORT/su,
    );
  });
});

describe('capability configuration composition', () => {
  it('extends the platform config without replacing it', () => {
    const config = load({ ...baseEnv(), MINIMAL_MAX_NOTES: '7' });
    expect(config.minimal.maxNotes).toBe(7);
    expect(config.service.name).toBe('platform-test');
    expect(config.auth.mode).toBe('api-key');
    expect(config.http.port).toBe(8080);
  });

  it('applies capability defaults', () => {
    const config = load(baseEnv());
    expect(config.minimal).toEqual({
      maxNotes: 50,
      greeting: 'minimal capability',
      strict: false,
    });
  });

  it('runs capability cross-field validation', () => {
    expect(() => load({ ...baseEnv(), MINIMAL_STRICT: 'true', MINIMAL_MAX_NOTES: '50' })).toThrow(
      /MINIMAL_STRICT=true requires/u,
    );
    expect(
      load({ ...baseEnv(), MINIMAL_STRICT: 'true', MINIMAL_MAX_NOTES: '5' }).minimal.strict,
    ).toBe(true);
  });

  it('reports capability schema failures as configuration errors', () => {
    expect(() => load({ ...baseEnv(), MINIMAL_MAX_NOTES: '-3' })).toThrow(ConfigurationError);
  });

  it('falls back to the platform config when no capability spec is supplied', () => {
    const config = loadCapabilityConfig({ defaults, source: baseEnv() });
    expect(config.service.name).toBe('platform-test');
    expect('minimal' in config).toBe(false);
  });
});
