import {
  MutationGate,
  approximateTokens,
  defineAgentToolCapability,
  jsonByteLength,
  readinessNotReady,
  readinessReady,
  type InvocationMeasurement,
} from '@agent-tool-platform/runtime';
import { minimalConfig, type MinimalConfig } from './config.js';
import { minimalInstructions } from './instructions.js';
import { NoteStore, RouteProbe, type MinimalServices } from './services.js';
import { minimalTools } from './tools.js';

/**
 * The minimal capability fixture.
 *
 * This exists solely to prove the platform end to end across HTTP, MCP, and OpenAPI. It is private
 * to this repository, it is never published, and it must not accumulate imitation domain behaviour
 * from any real capability.
 */
export const minimalCapability = defineAgentToolCapability({
  manifest: {
    name: 'minimal-capability',
    version: '0.1.0',
    title: 'Minimal Capability Fixture',
    description:
      'A private fixture capability that stores short notes in memory. It exists to exercise the ' +
      'agent tool platform runtime and is not a product tool server.',
  },

  instructions: minimalInstructions,

  config: minimalConfig,

  tools: minimalTools,

  createServices({ config }): MinimalServices {
    return {
      notes: new NoteStore(config.minimal.maxNotes),
      mutations: new MutationGate(config.mutations),
      routeProbe: new RouteProbe(),
    };
  },

  lifecycle: {
    start({ services, logger }) {
      services.notes.start();
      logger.debug({ event: 'fixture.started' }, 'note store started');
    },
    stop({ services }) {
      services.notes.stop();
    },
  },

  readiness: [
    ({ services }) =>
      services.notes.isStarted
        ? readinessReady('notes', `${services.notes.size} notes`)
        : readinessNotReady('notes', 'the note store has not started'),
  ],

  protectedRoutes: [
    (router, { services, config }) => {
      // A genuine extension route: aggregate counts that would be awkward as a tool. It inherits
      // authentication, rate limiting, request identity, and error handling from the platform.
      router.get('/notes/stats', () => {
        services.routeProbe.enter();
        return {
          greeting: config.minimal.greeting,
          count: services.notes.size,
          maxNotes: config.minimal.maxNotes,
        };
      });

      // Deliberately slow, so a test can hold a capability route in flight across shutdown and
      // observe that domain state is not torn down underneath it. Extension routes do not run
      // through the invoker, so this is the only way to exercise that path.
      router.get<{ Querystring: { delayMs?: string } }>('/notes/slow-stats', async (request) => {
        services.routeProbe.enter();
        const delayMs = Math.min(5000, Number.parseInt(request.query.delayMs ?? '100', 10) || 0);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        // Read domain state *after* the delay: if the stop hook had run, this would observe a
        // cleared store.
        return { count: services.notes.size, servedAfterMs: delayMs };
      });
    },
  ],

  telemetry: {
    estimateInvocation({ input, output }): InvocationMeasurement {
      const sourceBytes = jsonByteLength(input);
      const outputBytes = jsonByteLength(output);
      const rawEquivalentTokens = approximateTokens(sourceBytes * 8);
      const resultTokens = approximateTokens(outputBytes);
      return {
        sourceBytes,
        outputBytes,
        rawEquivalentTokens,
        resultTokens,
        estimatedTokensAvoided: Math.max(0, rawEquivalentTokens - resultTokens),
      };
    },
  },
});

export type { MinimalConfig, MinimalServices };
export { minimalConfig, minimalEnvSchema } from './config.js';
export { minimalInstructions } from './instructions.js';
export { NoteStore, RouteProbe } from './services.js';
export {
  brokenOutput,
  ignoreCancellation,
  listNotes,
  minimalTools,
  putNote,
  waitForCancellation,
} from './tools.js';
export default minimalCapability;
