# Agent Builder

Agent Builder is the private, local product UI for Agent Tool Platform. It lets a user discover
first-party capabilities, author a host-neutral agent, and run the real Agent Kit build pipeline
without learning Registry schemas, package identities, MCP transports, or binding keys.

H3 implements **Define** and **Build**. It does not implement **Prepare**, run an agent, install
capabilities, deploy providers, or manage Agent Instances.

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
- supported profiles and execution dimensions; and
- local, remote, or hybrid binding availability.

There is no UI-owned capability JSON. A Registry load failure is a visible error rather than an
empty or invented catalog.

## Agent authoring

The authoring surface requires:

- agent name;
- deterministic technical id;
- explicit initial version `1.0.0`;
- editable instructions; and
- one or more capability identities.

`Developer Optimization Agent` derives `developer-optimization`; the id remains inspectable and
editable. Agent Kit's public schema is authoritative for identifier, version, definition, and
selection validation. The normal UX does not expose host, version, profile, transport, or secret
controls.

The Developer Optimization preset uses one checked-in instruction source and selects:

1. `ast-summarizer`;
2. `git-optimizer`;
3. `data-cruncher`;
4. `doc-rag`;
5. `vision`;
6. `document-optimizer`; and
7. `azure`.

The preset only fills the ordinary form. It has no precomputed lock, bindings, readiness, or host
files and uses the same Build service as every other composition.

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
- local, remote, and hybrid bindings;
- exact readiness states and setup/configuration requirements;
- `agent.lock`;
- `.github/agents/<agent-id>.agent.md`;
- `.vscode/mcp.json`; and
- composed instructions.

Artifact previews use the exact strings returned by Agent Kit. Copying is browser-local; H3 does not
write generated files.

Authenticated remote bindings remain reference-based. For the baseline Azure entry, the result
shows the endpoint and `connector-api-key` requirements plus the Registry-defined `x-api-key`
mapping. The generated MCP file retains VS Code input references and contains no credential value.

## Build versus Prepare

Build creates a deterministic, validated composition and reports what an environment must provide.
It does not install an artifact, establish a provider connection, collect a credential, or prove
runtime health.

Prepare will later realize the build in a chosen environment and create the expanded Agent Instance
model. H3 deliberately renders Prepare as disabled/coming next. The application boundary is ready
for a future `prepareAgent(...)` service beside the existing Build service, but this branch defines
no replacement Prepare or Agent Instance contract. H7 reconciliation must consume the public
Platform contract after that work is reviewed and integrated.

## Validation

```bash
npm run builder:test      # service, API, component, error, and seven-capability acceptance tests
npm run typecheck
npm run build
npm run builder:smoke
```

The acceptance test sends the real Developer Optimization preset through the Builder service, real
Capability Registry, and `buildVsCodeAgent()`. It checks all seven resolutions, deterministic
outputs, binding/readiness presentation, generated files, and Azure configuration references
without supplying a secret.

## Current limitations

- Prepare and Run are not implemented.
- No files are exported or written.
- No capability or provider is installed/deployed.
- No endpoints or secret values are collected.
- No Agent Instance inventory, telemetry, or management view exists.
- VS Code is the only polished H3 adapter result.

H9 can add an `Agents` area to the existing product shell without replacing the catalog, authoring,
or Build service. It should consume the reconciled prepared-instance contracts rather than creating
an application-owned persistence schema.
