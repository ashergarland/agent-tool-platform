# @agent-tool-platform/testkit

Reusable conformance suites that prove a capability satisfies the agent tool platform contracts.

These suites test **platform invariants only**. No suite asserts anything about ASTs, repositories,
Azure resources, documents, or images — domain behaviour stays in the capability's own tests.

Version 0.1.0 is publicly available from the primary npm registry.

```bash
npm install -D @agent-tool-platform/testkit
```

The testkit depends on `@agent-tool-platform/runtime` at exactly the same version, so for v0 the two
are installed as a matched pair.

## Why it exists

Without it, every capability repository rewrites the same tests: does `/tools` require auth, does
the OpenAPI document match the registry, does MCP publish the same schemas as HTTP, does a weak API
key get refused. Rewritten tests drift, and a drifted test is worse than no test because it looks
like coverage.

## Usage

The testkit imports no test runner, so each suite runs inside whichever `it(...)` you already use.
A suite throws a `ConformanceError` naming every failed check, or returns a result you can inspect
with `{ throwOnFailure: false }`.

```ts
import { describe, it } from 'vitest';
import {
  runHttpConformance,
  runOpenApiConformance,
  runRegistryConformance,
  runTransportParity,
} from '@agent-tool-platform/testkit';

describe('platform conformance', () => {
  it('registry', async () => {
    await runRegistryConformance({ registry: app.registry, services: app.services });
  });

  it('openapi', () => {
    runOpenApiConformance({ document: app.openApiDocument(), registry: app.registry });
  });

  it('http', async () => {
    await runHttpConformance({ app: app.http, registry: app.registry, apiKey });
  });

  it('transport parity', async () => {
    await runTransportParity({
      app: app.http,
      createMcpServer: () => app.createStdioServer(),
      apiKey,
      samples: [{ name: 'my_read_tool', input: {} }],
    });
  });
});
```

## Suites

| Suite                        | Proves                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `runRegistryConformance`     | Unique names, published schemas, input and output validation, no leakage of an invalid handler result.              |
| `runRoutingConformance`      | Routing content quality, prerequisite and next-step references, state disclosure matching kind.                     |
| `runOpenApiConformance`      | One operation per tool, schemas derived from the registry, consequentiality following kind, shared error responses. |
| `runHttpConformance`         | Public and protected surfaces, request-id bounds and echo, cache headers, credential handling, normalized 404s.     |
| `runMcpConformance`          | Instructions published, tool metadata verbatim from the registry, read and write invocation, in-band failures.      |
| `runTransportParity`         | The same tool and input produce the same result over HTTP and MCP.                                                  |
| `runAuthConformance`         | Credential strength enforcement, safe principal identity, production refusal of disabled auth.                      |
| `runConfigConformance`       | Capability config composes with the platform, blank handling, strict booleans, cross-field validation.              |
| `runLifecycleConformance`    | Start and stop hooks, readiness aggregation, draining behaviour, in-flight cancellation.                            |
| `runRootBoundaryConformance` | In-root resolution, traversal denial, absolute and symlink escape denial, root addressability.                      |
| `runProcessConformance`      | No shell, timeouts, cancellation, output bounds, secret-free child environment, queue overflow.                     |
| `runMetadataConformance`     | Truthful metadata accepted, placeholders and version drift rejected.                                                |

## Fixtures

`generateTestApiKey`, `createTestPlatformConfig`, `createTestInvocationContext`, and
`connectInMemoryMcpClient` are exported so a capability's own tests do not have to invent a weaker
version of each.
