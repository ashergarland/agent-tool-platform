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
the capability `stop` hook, and closes the MCP server, once however often it is called. Signal
handlers are released only after all of that has settled, so a signal arriving during a long drain
cannot cut teardown short. A startup that fails after the capability has begun starting rolls the
application and any half-connected server back before rethrowing the original error.

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
| `/fs`           | `RootBoundary`, descriptor-backed confined files, and path containment helpers.                                                          |
| `/http`         | `createHttpServer`, `FixedWindowRateLimiter`, the Fastify adapter.                                                                       |
| `/lifecycle`    | `ApplicationLifecycle`, lifecycle-owned scratch types, readiness helpers, `installShutdownSignalHandlers`.                               |
| `/limits`       | Clamping, ceilings, bounded text, lists, and warnings.                                                                                   |
| `/logging`      | `createLogger`, redaction paths, `createSilentLogger`.                                                                                   |
| `/mcp`          | `createMcpServer`, stdio and Streamable HTTP adapters.                                                                                   |
| `/metadata`     | Capability metadata validation.                                                                                                          |
| `/mutations`    | `MutationGate`, `decideMutation`.                                                                                                        |
| `/openapi`      | `buildOpenApiDocument`.                                                                                                                  |
| `/process`      | `buildChildEnvironment`, `resolveExecutable`, `runBoundedProcess`.                                                                       |
| `/telemetry`    | The telemetry contract, sinks, and measurement sanitization.                                                                             |
| `/tools`        | `ToolDefinition`, `ToolRegistry`, routing grammar and rendering.                                                                         |

## Lifecycle-owned scratch workspaces

`CapabilityContext.createScratchWorkspace(options?)` atomically creates a private temporary
directory and returns `{ path, dispose() }`. The optional `prefix` is a filename prefix; the
optional `parentDirectory` must already exist. Without a parent, the operating system temporary
directory is used.

```ts
createServices: async ({ createScratchWorkspace }) => {
  const workspace = await createScratchWorkspace({ prefix: 'data-cruncher-' });
  return { workspace };
};
```

The application tracks every workspace until `dispose()` succeeds. Disposal is recursive,
concurrent-safe, and idempotent. Successful manual disposal removes the workspace from lifecycle
ownership. Otherwise the runtime attempts every remaining cleanup:

- if service construction, a capability start hook, or listener/transport startup fails;
- during fully drained shutdown, after admitted tool and custom-route work and the capability
  `stop` hook;
- after a timed-out drain eventually becomes idle, without deleting a directory that an admitted
  handler may still be using.

A fully drained `shutdown()` resolves only after owned cleanup finishes. If admitted work exceeds
the bounded drain budget, `shutdown()` rejects as incomplete while best-effort cleanup waits for
that work to settle. Signal-driven startup helpers therefore exit non-zero rather than claiming a
clean teardown; an in-process caller that keeps the process alive still gets deferred cleanup.
For hosted HTTP, the listener and active persistent connections are closed after the drain budget,
but a disconnected route remains tracked until its handler promise settles. Cleanup failures do not
skip later workspaces. Synchronous failures are surfaced; failures from necessarily deferred cleanup
are logged.

On POSIX, the directory is created with and reasserted to mode `0700`. Node's POSIX mode bits do not
describe Windows ACLs, so Windows guarantees atomic unique-directory creation and lifecycle
cleanup, not a claimed `0700` ACL equivalent.

Lifecycle ownership covers work the runtime admits and tracks. A capability that starts an
untracked background process must stop and await it itself; the platform cannot know that process
still uses the directory.

## Confined streaming files

`RootBoundary.openFile(untrustedRelativePath, { previewBytes? })` accepts the original untrusted
root-relative input and returns a `ConfinedOpenedFile`:

```ts
const file = await boundary.openFile(input.path, { previewBytes: 4096 });
try {
  for await (const chunk of file.createReadStream({ signal })) {
    // Consume bounded-memory Buffer chunks.
  }
} finally {
  await file.close();
}
```

The result exposes only canonical `relativePath`, descriptor `sizeBytes`, a bounded `preview`, a
descriptor-backed full stream, and idempotent `close()`. Preview uses a positional read at offset
zero, so it does not advance the stream. The stream starts at zero and is capped to the validated
size snapshot, so later file growth cannot exceed the opened-object size check. No raw descriptor or
absolute path is exposed.

The open sequence lexically confines the input, opens it once, `fstat`s the handle, requires a
regular file, enforces `maxFileBytes`, canonicalizes and confines the addressed path, and requires
matching non-zero `(dev, ino)` identity for the opened handle, the caller-addressed non-symlink
entry, and the canonical path. Every validation failure closes the handle.

- **POSIX:** Node exposes `O_NOFOLLOW`, so the final component is rejected atomically at open.
  Intermediate symlinks are allowed only when the opened object's canonical path remains in-root.
- **Windows:** Node does not expose `O_NOFOLLOW`. The runtime therefore opens first, rejects a
  stable final symlink with `lstat`, and returns the handle only after repeated path/handle identity
  checks establish an in-root non-symlink entry. Canonical ancestor comparison is case-exact so a
  case-sensitive NTFS sibling is not collapsed by `path.relative`. This does not claim POSIX's
  atomic no-follow guarantee.
- **Unsupported identity metadata:** if the filesystem/runtime reports inode identity as zero, the
  open fails closed because descriptor/path identity cannot be established.

`readFile(string)` uses the same primitive and then buffers its bounded stream. The legacy
`readFile(ResolvedPath)` overload remains available and now re-checks that the supplied path belongs
to the receiving boundary before opening it. Prefer original string input when final-component
symlink rejection must apply to the caller's exact spelling.

This confines only the file represented by the returned handle. It does not sandbox later path
access by Git, jq, ripgrep, or any other subprocess.

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
