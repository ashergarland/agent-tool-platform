# @agent-tool-platform/runtime

The shared runtime every `agent-tool-server-*` capability consumes.

This package owns transports, contracts, and safety primitives. It contains no domain behaviour and
never will: the moment it learns what an AST, a repository, or an Azure resource is, it stops being
a platform.

> **Not yet on npm.** This package is prepared for publication as a public package
> (`@agent-tool-platform/runtime`, version 0.1.0), but 0.1.0 has not been published. The install
> command below works once the first release is out; see [`docs/releasing.md`](../../docs/releasing.md).

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
} from '@agent-tool-platform/runtime';
```

Deliberate subpath exports exist for narrower imports:

| Subpath         | Contents                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| `/errors`       | `AppError`, the twelve error codes, constructors, `toAppError`, status and retryability mapping.            |
| `/cancellation` | `Deadline`, `linkSignals`, `whenAborted`, `neverCancelled`.                                                 |
| `/auth`         | `Principal`, `Authenticator`, API-key and Entra JWT authenticators, credential strength and fingerprinting. |
| `/capability`   | `defineAgentToolCapability`, `createAgentToolApplication`, `startAgentToolApplication`, `ToolInvoker`.      |
| `/concurrency`  | `BoundedSemaphore`, `BoundedQueue`.                                                                         |
| `/config`       | `PlatformConfig`, `defineCapabilityConfig`, `loadCapabilityConfig`, env parsing helpers.                    |
| `/context`      | Request-id resolution and bounds.                                                                           |
| `/fs`           | `RootBoundary` and path containment helpers.                                                                |
| `/http`         | `createHttpServer`, `FixedWindowRateLimiter`, the Fastify adapter.                                          |
| `/lifecycle`    | `ApplicationLifecycle`, `ReadinessAggregator`, readiness helpers.                                           |
| `/limits`       | Clamping, ceilings, bounded text, lists, and warnings.                                                      |
| `/logging`      | `createLogger`, redaction paths, `createSilentLogger`.                                                      |
| `/mcp`          | `createMcpServer`, stdio and Streamable HTTP adapters.                                                      |
| `/metadata`     | Capability metadata validation.                                                                             |
| `/mutations`    | `MutationGate`, `decideMutation`.                                                                           |
| `/openapi`      | `buildOpenApiDocument`.                                                                                     |
| `/process`      | `buildChildEnvironment`, `resolveExecutable`, `runBoundedProcess`.                                          |
| `/telemetry`    | The telemetry contract, sinks, and measurement sanitization.                                                |
| `/tools`        | `ToolDefinition`, `ToolRegistry`, routing grammar and rendering.                                            |

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
