import {
  ConfigurationError,
  loadCapabilityConfig,
  type AnyCapabilityConfigSpec,
  type PlatformConfig,
} from '@agent-tool-platform/runtime';
import { ConformanceRun, type ConformanceOptions, type ConformanceResult } from './harness.js';
import { generateTestApiKey } from './fixtures.js';

/**
 * Configuration conformance.
 *
 * Proves a capability's configuration composes with the platform rather than replacing it: the
 * platform surface survives, blank variables behave as unset, and capability cross-field
 * validation actually runs.
 */

export interface ConfigConformanceOptions<
  TConfig extends PlatformConfig,
> extends ConformanceOptions {
  readonly spec?: AnyCapabilityConfigSpec<TConfig> | undefined;
  readonly serviceName: string;
  readonly serviceVersion: string;
  /** Extra environment the capability needs to build a valid configuration. */
  readonly baseEnv?: NodeJS.ProcessEnv;
  /** Environments that must be rejected, each with a short reason for the report. */
  readonly invalidEnvironments?: readonly {
    readonly reason: string;
    readonly env: NodeJS.ProcessEnv;
  }[];
  /** Assertions on a successfully built configuration. */
  readonly expect?: (config: TConfig) => boolean;
}

export const runConfigConformance = async <TConfig extends PlatformConfig>(
  options: ConfigConformanceOptions<TConfig>,
): Promise<ConformanceResult> => {
  const run = new ConformanceRun('config');
  const defaults = {
    serviceName: options.serviceName,
    serviceVersion: options.serviceVersion,
  };
  const baseEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    AUTH_MODE: 'api-key',
    API_KEYS: generateTestApiKey(),
    ...options.baseEnv,
  };

  const load = (env: NodeJS.ProcessEnv): TConfig =>
    loadCapabilityConfig<TConfig>({ defaults, spec: options.spec, source: env });

  const config = load(baseEnv);
  run.equal(
    'the capability default service name is used',
    config.service.name,
    options.serviceName,
  );
  run.check('the platform HTTP surface survives composition', typeof config.http.port === 'number');
  run.check('the platform auth surface survives composition', config.auth.mode === 'api-key');
  run.check('the platform mutation policy survives composition', 'mutations' in config);

  const blank = load({ ...baseEnv, SERVICE_NAME: '   ', LOG_LEVEL: '' });
  run.equal('a blank variable behaves as unset', blank.service.name, options.serviceName);
  run.equal('a blank variable falls back to the default', blank.logging.level, 'info');

  const overridden = load({ ...baseEnv, SERVICE_NAME: 'renamed', PORT: '9999' });
  run.equal('SERVICE_NAME overrides the capability default', overridden.service.name, 'renamed');
  run.equal('PORT is coerced to a number', overridden.http.port, 9999);

  const truthy = load({ ...baseEnv, MUTATIONS_ENABLED: 'yes' });
  run.equal('strict booleans accept documented spellings', truthy.mutations.enabled, true);
  await run.throws(
    'strict booleans reject unrecognized values',
    () => load({ ...baseEnv, MUTATIONS_ENABLED: 'maybe' }),
    (error) => error instanceof ConfigurationError,
  );

  if (options.expect) {
    run.check('the capability configuration matches expectations', options.expect(config));
  }

  for (const invalid of options.invalidEnvironments ?? []) {
    await run.throws(
      `rejects invalid configuration: ${invalid.reason}`,
      () => load({ ...baseEnv, ...invalid.env }),
      (error) => error instanceof ConfigurationError,
    );
  }

  return run.finish(options);
};
