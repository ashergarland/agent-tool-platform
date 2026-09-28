# Agent Builder

Agent Builder is the private, local product UI for Agent Tool Platform. It lets a user discover
first-party capabilities, author a host-neutral agent, and run the real Agent Kit build pipeline
without learning Registry schemas, package identities, MCP transports, or binding keys.

Builder implements **Define**, **Build**, and **Prepare**, including capability execution/profile
policy and bounded local persistence/discovery of the resulting Prepared Agent Instance. It does not
run an agent, generically install capabilities, deploy providers, collect telemetry, or provide the
full Agent Management product.

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
AgentDefinition / agent.lock / readiness / VS Code outputs / Prepared Agent Instance
```

The Registry loader and Agent Kit use Node APIs, so they remain behind a small same-origin HTTP
boundary rather than entering the browser bundle. The backend uses the Node HTTP server directly;
there is no full-stack framework, database, mutable secondary index, proxy, or second composition
engine. Builder owns one bounded user-local filesystem store for canonical Prepared Agent Instance
records. Vite runs as development middleware, and the same Node server serves bounded production
assets after build.
Development, typecheck, test, and production build scripts first build the Platform dependencies,
then resolve their package-root exports to `dist/index.js` and `dist/index.d.ts`. Builder
configuration does not alias public Platform package names to package source.

The API exposes only:

- `GET /api/health`;
- `GET /api/capabilities`;
- `GET /api/instances`;
- `POST /api/build`; and
- `POST /api/prepare`.

It has no arbitrary filesystem read/write, shell, package installation, command execution, or HTTP
proxy operation. Requests are size-bounded, Build accepts one exact `definition` property, and
Prepare accepts only the canonical definition, expected lock digest, and fixed local VS Code
environment identifier. Instance discovery accepts no path, filename, import, or state-root
parameter. The listener binds to `127.0.0.1`. Secret and endpoint values are neither requested,
returned, logged, nor persisted.

## Local state

Builder stores prepared instances beneath:

```text
<state-root>/instances/
```

The default state root is `<user-home>/.agent-tool-platform`. Set
`AGENT_TOOL_PLATFORM_STATE_DIR` in the Builder process environment to use another root, including an
isolated temporary root for tests or local review. This path is process-owned configuration: it is
not accepted from the browser and is not returned through the normal API.

Each instance uses one portable `<64-lowercase-hex-digest>.json` filename derived from its validated
Agent Kit `sha256:<digest>` instance ID. Builder writes canonical
`serializePreparedAgentInstance()` output through a same-directory temporary file, flushes it, and
atomically replaces the instance record. Discovery enumerates only canonical-looking filenames,
bounds file count and size, rejects unexpected file types and filename/record identity mismatches,
and validates every record with `parsePreparedAgentInstance()`. Invalid records are isolated and
reported through bounded counts/warnings; storage paths and raw local diagnostics are not exposed.

Filesystem confinement follows the Runtime `RootBoundary` model. Reads validate a regular-file
descriptor against the addressed and canonical paths with non-zero device/inode identity, repeat
the final addressed-path check, and consume bounded bytes from that same descriptor. Writes keep
validated state-root and instances-directory descriptors open, validate the temporary file and any
existing target before replacement, and validate the persisted identity and canonical contents
after replacement. Stable pre-existing symlinks, Windows junctions represented by Node as
symlinks, canonical escapes, and identity changes observed at those checks fail closed.

Windows has a narrower guarantee against an actively racing same-user process. Node 22 exposes
neither `O_NOFOLLOW` nor a directory-handle-relative `renameat`/replace operation, and Windows does
not permit the existing target handle to remain open across replacement. Builder must therefore
close the validated target and call path-based `rename()`. A process that can concurrently mutate
the state directory can still replace a final component or ancestor after the last pre-replacement
identity check and before that OS operation. Post-replacement validation detects an observed
mismatch but cannot make the destination operation descriptor-anchored retroactively. This matches
the Runtime's documented weaker Windows `RootBoundary` threat model. Directory creation and failed
temporary-file cleanup are also path-based and have the same active-racer limitation despite their
surrounding identity checks. Builder does not claim race-free filesystem mutation against such an
active same-user attacker.

There is no secondary index. A repeated Prepare of the same Build, host, and environment reads the
stored instance back into Agent Kit and updates the same record. A different lock/Build or
environment produces a different Agent Kit instance ID and may coexist. One canonical agent can
therefore have multiple local Agent Instances.

The stored document is only the canonical `PreparedAgentInstance`. It does not include canonical
instructions, prompts, generated VS Code file content, MCP configuration content, endpoint or
secret values, credentials, absolute workspace paths, source code, telemetry, runtime activity, or
arbitrary UI state.

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

Prepare realizes that exact Build for one bounded environment and returns an H7 Prepared Agent
Instance. The browser sends the canonical `AgentDefinition` used for Build, the displayed lock
digest, and the fixed `local-vscode-builder` environment id. The stateless server reloads the same
first-party Registry, reruns `buildVsCodeAgent()`, and rejects the request if the rebuilt lock digest
does not exactly match. It never accepts a browser-reconstructed `AgentBuild` and keeps no Build
cache.

After lock verification, Builder calls the public Agent Kit `createPreparationPlan()` and
`prepareAgent()` APIs. Agent Kit remains authoritative for Build consistency, plan and action
identity, readiness reconciliation, instance identity and state, runnable state, setup requirements,
action results, and created/updated disposition. Builder only projects those contracts into a
presentation-safe response.

### Truthful readiness evidence

The production local VS Code preparation environment starts with an empty `ReadinessSnapshot`.
Builder does not infer local availability from a published package, remote availability from an
endpoint reference, provider readiness from Registry metadata, or configuration availability from a
required name. Generated VS Code files are previewed but not written, so host integration also starts
as `setup-required`.

Consequently, the current Developer Optimization Agent normally prepares to `NEEDS_SETUP` and is not
runnable. That is a successful Prepare result: the canonical agent has been realized as an Agent
Instance contract while its environment requirements remain unresolved. `UNAVAILABLE` is reserved
for concrete unavailable evidence, and `READY` requires every capability binding plus host
integration to be satisfied. Prepare does not manufacture the later runtime/telemetry states
`ACTIVE` or `DEGRADED`.

### Preparation driver boundary

Builder exposes a server-side preparation-environment seam for a `ReadinessSnapshot`,
`PreparationDriver`, host-integration evidence, and clock. The instance store is the sole
production reconciliation source for an existing instance. Production injects no driver because it
cannot currently satisfy unresolved actions safely. Agent Kit therefore
returns `setup-required` for local artifact availability, named configuration, remote connection,
provider prerequisites, and generated host integration that lack evidence.

Tests inject controlled evidence and a narrow driver to prove the same integration can produce a
runnable `READY` instance and can reconcile an existing instance with deterministic identity. That
synthetic evidence is test-only. Builder does not run npm installation, package lifecycle scripts,
OCI workloads, shell commands, provider provisioning, Azure calls, or arbitrary filesystem writes.

### Agent Instance boundary

The Prepare response displays the deterministic instance id, environment id, `READY`,
`NEEDS_SETUP`, or `UNAVAILABLE` state, runnable flag, disposition, action results, capability
readiness, host-integration result, and unresolved setup requirements. It keeps Build-selected local,
remote, and hybrid bindings unchanged and never writes environment state into `AgentDefinition` or
`agent.yaml`.

The persisted instance is rediscovered through `GET /api/instances` when Builder starts again.
Discovery projects only presentation-safe identity, prepared state, lock, host/environment, and
binding readiness fields from validated records. Persistence does not change H7 readiness:
`NEEDS_SETUP` remains not runnable, writing a file does not make an instance `READY`, and
`preparedAt` is a preparation/reconciliation timestamp rather than `lastActiveAt`.

Run remains disabled and no execution is implied. Builder does not infer `ACTIVE`, `DEGRADED`,
runtime health, usage, success rate, or last-active time from the existence or age of an instance
record. Full Agent Management and telemetry remain future work.

## Validation

```bash
npm run builder:test      # service, API, component, error, and seven-capability acceptance tests
npm run test:coverage --workspace @agent-tool-platform/agent-builder
npm run typecheck
npm run build
npm run builder:smoke
```

The tests send Automatic, Local only, Custom, and the real Developer Optimization preset through the
Builder service/API boundary, real Capability Registry, `buildVsCodeAgent()`,
`createPreparationPlan()`, and `prepareAgent()`. They check Registry-derived profile choices,
mutation posture, local-only incompatibility, mixed execution, deterministic outputs, lock mismatch
rejection, conservative production readiness, synthetic `READY`, persisted reconciliation,
restart discovery, atomic Windows-safe records, corruption isolation, bounded HTTP handling, all
three preparation states, generated files, and Azure configuration references without supplying a
secret.

## Current limitations

- Run is not implemented.
- No files are exported or written.
- No capability or provider is installed/deployed.
- No endpoints or secret values are collected.
- The local instance section is discovery, not the full Agent Management product.
- No instance deletion/import lifecycle, telemetry, runtime health, activity, or history exists.
- No external registry, fleet, database, daemon, or managed deployment is used.
- VS Code is the only polished Builder adapter result.
