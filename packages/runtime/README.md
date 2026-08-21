# @agent-tool-platform/runtime

The shared runtime every `agent-tool-server-*` capability consumes.

This package owns transports, contracts, and safety primitives. It contains no domain behaviour and
never will: the moment it learns what an AST, a repository, or an Azure resource is, it stops being
a platform.

Version 0.1.0 is publicly available from the primary npm registry.

```bash
npm install @agent-tool-platform/runtime
```

## Import surface

The root export carries everything:

```ts
import {
  defineAgentToolCapability,
  defineTool,
  startAgentToolApplication,
  startStdioAgentToolApplication,
} from '@agent-tool-platform/runtime';
```

## Starting a capability

| Entry point                                         | Use for                                                                    |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| `startAgentToolApplication(capability, options?)`   | A hosted deployment. Binds the HTTP listener and installs signal handlers. |
| `startStdioAgentToolApplication(capability, opts?)` | A local stdio process launched by an agent host. Binds no listener.        |
| `createAgentToolApplication(capability, options?)`  | Tests and advanced callers. Assembles the application and starts nothing.  |

The stdio helper is the preferred startup mechanism for a local entry point. It owns the whole
local lifecycle — silent logger, local execution semantics, capability start hook, MCP server,
transport, `SIGINT`/`SIGTERM` handling, ordered teardown, and the process exit code — so a
capability entry point is only its own environment policy:

```ts
import { startStdioAgentToolApplication } from '@agent-tool-platform/runtime';
import capability from './capability.js';

await startStdioAgentToolApplication(capability, {
  env: {
    ...process.env,
    // A capability-specific default. The platform never learns what this variable means.
    CAPABILITY_WORKSPACE_ROOT: process.env.CAPABILITY_WORKSPACE_ROOT?.trim() || process.cwd(),
  },
});
```

It resolves to `{ application, server, transport, close }`. `close()` drains the application, runs
the capability `stop` hook, and closes the MCP server, once however often it is called.

Because stdio is a local pipe with no network peer, the helper applies local execution semantics
over the environment it is given — authentication disabled, non-production `NODE_ENV` (a `test`
environment is preserved), loopback host — after the caller's own values, so an inherited
production environment cannot change how a local process runs. No listener is ever bound, and the
default logger is silent because stdout carries protocol traffic. Hosted HTTP semantics are
unchanged: disabled authentication is still refused in production there.

Deliberate subpath exports exist for narrower imports:

| Subpath         | Contents                                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `/errors`       | `AppError`, the twelve error codes, constructors, `toAppError`, status and retryability mapping.                                         |
| `/cancellation` | `Deadline`, `linkSignals`, `whenAborted`, `neverCancelled`.                                                                              |
| `/auth`         | `Principal`, `Authenticator`, API-key and Entra JWT authenticators, credential strength and fingerprinting.                              |
| `/capability`   | `defineAgentToolCapability`, `createAgentToolApplication`, `startAgentToolApplication`, `startStdioAgentToolApplication`, `ToolInvoker`. |
| `/concurrency`  | `BoundedSemaphore`, `BoundedQueue`.                                                                                                      |
| `/config`       | `PlatformConfig`, `defineCapabilityConfig`, `loadCapabilityConfig`, env parsing helpers.                                                 |
| `/context`      | Request-id resolution and bounds.                                                                                                        |
| `/fs`           | `RootBoundary` and path containment helpers.                                                                                             |
| `/http`         | `createHttpServer`, `FixedWindowRateLimiter`, the Fastify adapter.                                                                       |
| `/lifecycle`    | `ApplicationLifecycle`, `ReadinessAggregator`, readiness helpers, `installShutdownSignalHandlers`.                                       |
| `/limits`       | Clamping, ceilings, bounded text, lists, and warnings.                                                                                   |
| `/logging`      | `createLogger`, redaction paths, `createSilentLogger`.                                                                                   |
| `/mcp`          | `createMcpServer`, stdio and Streamable HTTP adapters.                                                                                   |
| `/metadata`     | Capability metadata validation.                                                                                                          |
| `/mutations`    | `MutationGate`, `decideMutation`.                                                                                                        |
| `/openapi`      | `buildOpenApiDocument`.                                                                                                                  |
| `/process`      | `buildChildEnvironment`, `resolveExecutable`, `runBoundedProcess`.                                                                       |
| `/telemetry`    | The telemetry contract, sinks, and measurement sanitization.                                                                             |
| `/tools`        | `ToolDefinition`, `ToolRegistry`, routing grammar and rendering.                                                                         |

## Binary

```bash
agent-tool-validate-metadata --server server.json --package package.json [--registry entry.json]
```

Validates a capability repository's metadata: schema shape, semantic versioning, version agreement
between `server.json` and `package.json`, truthful package and remote declarations, and the absence
of placeholder content.

## Documentation

See the [repository README](../../README.md) for the architecture, the capability contract, and the
ownership boundaries between the platform, capabilities, and agent repositories.
