# Agent Builder

Agent Builder is the private, local product UI for Agent Tool Platform. It lets a user discover
first-party capabilities, author a host-neutral agent, and run the real Agent Kit build pipeline
without learning Registry schemas, package identities, MCP transports, or binding keys.

Builder implements **Define** and **Build**, including capability execution/profile policy. It does
not implement **Prepare**, run an agent, install capabilities, deploy providers, or manage Agent
Instances.

## Architecture

```text
Browser (React + Vite)
   |
   | same-origin JSON
   v
Agent Builder local Node application (127.0.0.1 only)
   |
   +-- Capability Registry public package API
   +-- Agent Kit public package API
   |
   v
AgentDefinition / agent.lock / readiness / VS Code outputs
```

The Registry loader and Agent Kit use Node APIs, so they remain behind a small same-origin HTTP
boundary rather than entering the browser bundle. The backend uses the Node HTTP server directly;
there is no full-stack framework, persistence tier, proxy, or second composition engine. Vite runs
as development middleware, and the same Node server serves bounded production assets after build.
Development, typecheck, test, and production build scripts first build the Platform dependencies,
then resolve their package-root exports to `dist/index.js` and `dist/index.d.ts`. Builder
configuration does not alias public Platform package names to package source.

The API exposes only:

- `GET /api/health`;
- `GET /api/capabilities`; and
- `POST /api/build`.

It has no arbitrary filesystem read/write, shell, package installation, command execution, or HTTP
proxy operation. Requests are size-bounded, Build accepts one exact `definition` property, and the
listener binds to `127.0.0.1`. Secret and endpoint values are neither requested nor persisted.

## Start

From the repository root:

```bash
npm install
npm run builder:dev
```

Open `http://127.0.0.1:4173`. Set `AGENT_BUILDER_PORT` to another valid local port if 4173 is in
use. The host is intentionally not configurable.

For a production-equivalent local check:

```bash
npm run build
npm run builder:smoke
npm start --workspace @agent-tool-platform/agent-builder
```

The application workspace is `private: true`. It is not part of the four-package Platform
publication set and has no deployment workflow.

## Capability catalog

Catalog cards are projected directly from the live first-party Registry reader. They show available
Registry presentation data:

- display name, id, description, and exact current version/status;
- category, tags, and tool count;
- supported profiles and their read-only or mutating posture; and
- local, remote, or hybrid binding availability for each profile.

There is no UI-owned capability JSON. A Registry load failure is a visible error rather than an
empty or invented catalog.

## Agent authoring

The authoring surface requires:

- agent name;
- deterministic technical id;
- explicit initial version `1.0.0`;
- editable instructions; and
- one or more capability identities; and
- an execution policy: Automatic, Local only, or Custom.

`Developer Optimization Agent` derives `developer-optimization`; the id remains inspectable and
editable. Agent Kit's public schema is authoritative for identifier, version, definition, and
selection validation. Automatic remains the default and omits profile values so Agent Kit retains
authority over normal profile and binding resolution. Local only writes explicit Registry profile
ids and blocks Build when any selected capability lacks a local profile. Custom exposes friendly
profile choices only when the Registry declares meaningful alternatives. Binding ids, transport
configuration, endpoints, and secret values are not authoring controls.

The Builder keeps two axes distinct:

1. the Agent runtime is a local VS Code agent; and
2. each capability independently resolves to Local, Remote, or Hybrid execution.

Every profile choice also shows its separate Read-only or Mutating posture. Read-only profiles are
presented before mutating alternatives, and mutation is never inferred from execution topology.

The Developer Optimization preset uses one checked-in instruction source and selects:

1. `ast-summarizer`;
2. `git-optimizer`;
3. `data-cruncher`;
4. `doc-rag`;
5. `vision` with explicit `local-package`;
6. `document-optimizer`; and
7. `azure` with explicit `hosted-read-only`.

The preset only fills the ordinary form. It has no precomputed lock, bindings, readiness, or host
files and uses the same Build service as every other composition. Its explicit profiles appear as
Custom selections so the form truthfully represents its canonical definition.

## Build

The exact flow is:

```text
React form
   -> canonical AgentDefinition
   -> Builder build service
   -> loadFirstPartyCapabilityRegistry()
   -> createCapabilityRegistryReader()
   -> buildVsCodeAgent()
   -> AgentBuild presentation
   -> React result
```

Agent Kit remains authoritative for definition validation, version/profile/binding resolution,
compatibility, instruction composition, lock generation/digest, readiness, the existing Agent
Instance identity seam, and VS Code adapter output.

The result displays:

- resolved capability versions and profiles;
- local, remote, and hybrid bindings plus read-only or mutating posture;
- the local Agent runtime separately from mixed capability execution;
- exact readiness states and setup/configuration requirements;
- `agent.lock`;
- `.github/agents/<agent-id>.agent.md`;
- `.vscode/mcp.json`; and
- composed instructions.

Artifact previews use the exact strings returned by Agent Kit. Copying is browser-local; Builder
does not write generated files.

Authenticated remote bindings remain reference-based. For the baseline Azure entry, the result
shows the endpoint and `connector-api-key` requirements plus the Registry-defined `x-api-key`
mapping. The generated MCP file retains VS Code input references and contains no credential value.

## Build versus Prepare

Build creates a deterministic, validated composition and reports what an environment must provide.
It does not install an artifact, establish a provider connection, collect a credential, or prove
runtime health.

Prepare can later realize the build in a chosen environment and create an Agent Instance. Builder
deliberately renders Prepare as disabled/coming next and invokes no Prepare API. This implementation
defines no replacement Prepare or Agent Instance contract.

## Validation

```bash
npm run builder:test      # service, API, component, error, and seven-capability acceptance tests
npm run test:coverage --workspace @agent-tool-platform/agent-builder
npm run typecheck
npm run build
npm run builder:smoke
```

The tests send Automatic, Local only, Custom, and the real Developer Optimization preset through
the Builder service/API boundary, real Capability Registry, and `buildVsCodeAgent()`. They check
Registry-derived profile choices, mutation posture, local-only incompatibility, mixed execution,
deterministic outputs, binding/readiness presentation, generated files, and Azure configuration
references without supplying a secret.

## Current limitations

- Prepare and Run are not implemented.
- No files are exported or written.
- No capability or provider is installed/deployed.
- No endpoints or secret values are collected.
- No Agent Instance inventory, telemetry, or management view exists.
- VS Code is the only polished Builder adapter result.
