import { z } from 'zod';
import {
  defineAgentToolCapability,
  defineTool,
  startStdioAgentToolApplication,
} from '../../packages/runtime/src/index.js';

/**
 * A real stdio process, for the one assertion an in-process test cannot make.
 *
 * `tests/stdio.test.ts` injects streams, which proves the transport wiring but leaves the actual
 * file descriptor unexamined: a stray `console.log`, a logger pointed at the wrong destination, or
 * a dependency that greets stdout would all go to the test runner's own output and be invisible.
 * Here the process is spawned with its stdout piped, so fd 1 can be captured byte for byte across
 * startup, requests, and shutdown, and every line held to the protocol.
 *
 * Imports reach into `packages/runtime/src` on purpose: this runs under `tsx`, before any build, so
 * there is no `dist/` to resolve and no workspace alias outside vitest.
 */

let requestShutdown = (): void => undefined;
const shutdownRequested = new Promise<void>((resolve) => {
  requestShutdown = resolve;
});

const capability = defineAgentToolCapability<Record<string, never>>({
  manifest: {
    name: 'stdio-child-probe',
    version: '0.0.0-test',
    title: 'Stdio Child Probe',
    description: 'A test-only capability spawned as a real process to prove stdout stays clean.',
  },
  instructions: 'Routing: test-only capability. Use nothing here for real work.',
  tools: [
    defineTool({
      name: 'echo',
      title: 'Echo',
      summary: 'Returns what it was given.',
      description: 'Returns what it was given, so a real round trip can be observed.',
      kind: 'read',
      routing: {
        useWhen: ['never'],
        doNotUseWhen: ['you want anything to happen'],
        changesState: false,
      },
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ value: z.string() }),
      handler(input) {
        return Promise.resolve({ value: input.value });
      },
    }),
    defineTool({
      name: 'stop_server',
      title: 'Stop server',
      summary: 'Asks this process to shut down.',
      description:
        'Asks this process to shut down. Windows has no deliverable SIGTERM, so the graceful ' +
        'teardown path needs a request the test can make on every platform.',
      kind: 'read',
      routing: {
        useWhen: ['never'],
        doNotUseWhen: ['you want anything to happen'],
        changesState: false,
      },
      inputSchema: z.object({}),
      outputSchema: z.object({ stopping: z.boolean() }),
      handler() {
        // Resolved rather than awaited, so this call still gets its reply before teardown begins.
        requestShutdown();
        return Promise.resolve({ stopping: true });
      },
    }),
  ],
  createServices(): Record<string, never> {
    return {};
  },
});

const stdio = await startStdioAgentToolApplication<Record<string, never>>(capability, {
  env: { ...process.env, NODE_ENV: 'test' },
});

await shutdownRequested;
await stdio.close();
