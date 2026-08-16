import {
  createAgentToolApplication,
  RecordingTelemetrySink,
  createSilentLogger,
  type AgentToolApplication,
} from '@agent-tool-platform/runtime';
import { generateTestApiKey } from '@agent-tool-platform/testkit';
import minimalCapability, {
  type MinimalConfig,
  type MinimalServices,
} from '@agent-tool-platform/example-minimal-capability';

export type FixtureApplication = AgentToolApplication<MinimalConfig, MinimalServices>;

export interface FixtureOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly telemetry?: RecordingTelemetrySink;
  readonly readinessCacheMs?: number;
  /** Share one credential across several applications, as the lifecycle conformance suite needs. */
  readonly apiKey?: string;
}

export interface Fixture {
  readonly application: FixtureApplication;
  readonly apiKey: string;
  readonly telemetry: RecordingTelemetrySink;
}

/** Builds the fixture capability with a generated credential and a silent logger. */
export const createFixture = async (options: FixtureOptions = {}): Promise<Fixture> => {
  const apiKey = options.apiKey ?? generateTestApiKey();
  const telemetry = options.telemetry ?? new RecordingTelemetrySink();
  const application = await createAgentToolApplication<MinimalServices, MinimalConfig>(
    minimalCapability,
    {
      logger: createSilentLogger(),
      telemetry,
      readinessCacheMs: options.readinessCacheMs ?? 0,
      env: {
        NODE_ENV: 'test',
        AUTH_MODE: 'api-key',
        API_KEYS: apiKey,
        ...options.env,
      },
    },
  );
  return { application, apiKey, telemetry };
};

export const createStartedFixture = async (options: FixtureOptions = {}): Promise<Fixture> => {
  const fixture = await createFixture(options);
  await fixture.application.start();
  return fixture;
};

export const bearer = (apiKey: string): Record<string, string> => ({
  authorization: `Bearer ${apiKey}`,
  'content-type': 'application/json',
});
