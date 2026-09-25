# @agent-tool-platform/agent-kit

The host-neutral composition engine beneath Agent Builder.

Agent Kit converts a canonical agent definition into a validated, reproducible build. It resolves
capability releases through a narrow registry reader, selects a compatible six-dimensional
capability profile, generates `agent.lock`, composes bounded instructions, produces a readiness
plan, and delegates host files to an adapter. It can then prepare that immutable build in one
specific environment and produce a validated Agent Instance record.

The package and its sibling first-party registry are public. Their checked-in development manifests
deliberately stay private; release stamping removes those guards only in an ephemeral candidate. An
agent composition repository installs an exact lockstep Platform release:

```bash
npm install @agent-tool-platform/agent-kit@X.Y.Z
```

## Boundary

Agent Kit owns:

- canonical agent definition validation and normalization;
- exact capability release and execution-profile resolution;
- compatibility validation;
- deterministic lock serialization and SHA-256 identities;
- bounded agent/capability instruction composition;
- environment-neutral readiness requirements;
- host adapter generation;
- deterministic preparation plans and a bounded environment driver contract;
- environment-specific prepared Agent Instance records and consumer-owned serialization.

It does not execute capability tools, deploy providers, store registry data, collect telemetry, or
manage running instances. Preparation never changes a selected capability version, profile,
binding, lock identity, instruction set, or host adapter meaning.

## Build, Prepare, Agent Instance, and Run

These stages deliberately answer different questions:

| Stage          | Responsibility                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| Build          | Resolve immutable composition, exact versions, profiles, bindings, compatibility, host files, and requirements. |
| Prepare        | Reconcile that locked build with evidence and bounded actions in one named environment.                         |
| Agent Instance | Record the stable build/host/environment identity and mutable prepared readiness for that environment.          |
| Run            | Execute work and report activity or runtime health; this is outside Agent Kit preparation.                      |

`READY` means every required binding and the generated host integration are prepared. It does not
mean a process is currently running, and Prepare never reports `ACTIVE`. A prepared local stdio
binding can therefore remain `READY` while its process is inactive. Likewise, a reachable remote
endpoint does not prove that an external provider prerequisite is ready: connection and provider
evidence remain independent.

## Canonical definition

```json
{
  "schemaVersion": 1,
  "id": "developer-optimization",
  "name": "Developer Optimization",
  "version": "1.0.0",
  "instructions": "Prefer compact, evidence-backed capability output.",
  "capabilities": [{ "id": "ast-summarizer" }, { "id": "git-optimizer", "version": "0.1.0" }]
}
```

Capability selections name capabilities, not MCP tools. An omitted capability version resolves to
the static registry's pinned current version and is then recorded exactly in the lock. An exact
requested version must match that entry; Agent Kit does not forward version requests to or invent a
multi-version registry API. An optional `profile` selects a declared capability profile; otherwise
Agent Kit deterministically prefers read-only profiles before mutating profiles, then local, hybrid,
and remote bindings.

## Registry seam

Agent Kit consumes the Capability Registry package's public reader and canonical entries:

```ts
import {
  createCapabilityRegistryReader,
  loadFirstPartyCapabilityRegistry,
} from '@agent-tool-platform/capability-registry';

const registry = createCapabilityRegistryReader(await loadFirstPartyCapabilityRegistry());
```

Reader results are validated against the Registry's public `CapabilityEntry` schema and consistency
rules, plus Agent Kit's build-safety constraints for public artifact identities and portable
references. The six-dimensional profile summaries and explicit bindings come directly from the
canonical Registry entry. Capability instructions and per-tool routing remain capability-owned and
are delivered by the MCP runtime; Agent Kit composes bounded capability/profile boundaries and the
Registry routing summary rather than copying tool schemas. Artifacts, pinned source revisions, and
a digest of each complete consumed Registry entry provide reproducible identity.

## VS Code build

```ts
import { buildVsCodeAgent } from '@agent-tool-platform/agent-kit';

const build = await buildVsCodeAgent(definition, {
  registry,
  readinessSnapshot: {
    schemaVersion: 1,
    availableLocalBindings: [],
  },
});

build.lockText; // deterministic agent.lock JSON
build.adapter.files; // .github/agents/<id>.agent.md and .vscode/mcp.json
build.readiness; // machine-readable preparation requirements
build.instanceIdentity; // immutable build/host seam for environment-specific identity
```

The VS Code adapter uses exact package versions for local stdio servers and input placeholders for
remote endpoints or named configuration. Declared-but-unpublished packages use offline launch mode
and remain a Prepare requirement.

For remote HTTP bindings, Agent Kit carries the Registry's validated header name, configuration
name, and safe literal prefix into the resolved execution binding. The VS Code adapter emits one
ordinary endpoint input and separate password inputs for required authentication configuration:

```json
{
  "inputs": [
    {
      "id": "example-access-token",
      "type": "promptString",
      "description": "Example: access-token",
      "password": true
    },
    {
      "id": "example-endpoint",
      "type": "promptString",
      "description": "Example MCP endpoint"
    }
  ],
  "servers": {
    "example": {
      "type": "http",
      "url": "${input:example-endpoint}",
      "headers": {
        "Authorization": "Bearer ${input:example-access-token}"
      }
    }
  }
}
```

This shape follows the authoritative
[VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration):
remote servers use `type`, `url`, and string-valued `headers`, and `promptString` inputs support
substring substitution. Agent Kit uses only the Registry's literal prefix; it does not implement
templates, transforms, encoding, or inferred authentication schemes.

Authenticated remote HTTP is host-compatible only when the Registry mapping is complete and the
adapter can express it faithfully. Missing or unsupported transport semantics remain incompatible.
Unauthenticated remote HTTP remains compatible, and local/hybrid stdio configuration continues to
use environment-variable input references.

Lock schema `2` persists the selected client mapping under the binding using only the header name,
configuration name, and literal prefix. Registry entry digests also cover the complete source
mapping. VS Code adapter schema `2` identifies the new compatibility and generated-header
semantics. Configuration values, endpoint values, credentials, absolute local paths, and live
provider identifiers never enter `agent.lock` or generated files.

## Readiness

Readiness is a plan, not a liveness probe. It distinguishes:

- locally available bindings;
- local setup still required;
- remote or provider setup still required;
- missing named configuration;
- incompatible bindings.

Compatibility answers whether a host can represent the selected binding. Readiness separately
answers whether its named configuration, remote connection, local artifact, and provider
prerequisites have been prepared. Generating an authenticated HTTP server therefore makes the
binding compatible but does not mark a missing token, endpoint, or provider prerequisite ready.

An installed local binding can be ready while its process is inactive. Runtime activity remains a
later Run/telemetry concern; provider prerequisites are assessed separately during Prepare.

## Prepare

Preparation planning and environment mutation are separate. `createPreparationPlan()` emits a
deterministic, capability-neutral list of actions. `prepareAgent()` then satisfies actions from the
provided readiness snapshot or delegates unresolved actions through a narrow `PreparationDriver`.
The driver receives only bounded operations such as local artifact preparation, named
configuration verification, remote connection verification, provider prerequisite verification,
and host integration preparation. It is not a shell runner.

```ts
import {
  createPreparationPlan,
  prepareAgent,
  serializePreparedAgentInstance,
  type PreparationDriver,
} from '@agent-tool-platform/agent-kit';

const readinessSnapshot = {
  schemaVersion: 1 as const,
  availableLocalBindings: ['ast-summarizer@0.1.1#local-package'],
};

const plan = createPreparationPlan(build, {
  environmentId: 'developer-workstation',
  readinessSnapshot,
});

const driver: PreparationDriver = {
  async execute(request) {
    if (request.action.kind === 'prepare-host-integration') {
      await writeGeneratedHostFiles(request.generatedHostFiles);
      return { status: 'success' };
    }
    return { status: 'setup-required' };
  },
};

const prepared = await prepareAgent(build, {
  environmentId: 'developer-workstation',
  readinessSnapshot,
  driver,
});

prepared.plan; // the same deterministic preparation plan
prepared.readiness; // reconciled through createReadinessPlan()
prepared.instance; // environment-specific PreparedAgentInstance
prepared.runnable; // true only when preparation produced READY
prepared.setupRequirements; // bounded unresolved or unavailable actions

const instanceText = serializePreparedAgentInstance(prepared.instance);
```

Driver results are one of `success`, `already-ready`, `setup-required`, or `unavailable`. Missing
ordinary setup produces `NEEDS_SETUP`; concrete unavailable evidence can produce `UNAVAILABLE`.
`DEGRADED` and `ACTIVE` are part of the shared instance state vocabulary for later runtime and
telemetry updates, but H7 preparation does not manufacture either state.

The readiness snapshot remains the semantic source of truth for binding readiness. Successful
driver checks add only availability facts to an in-memory snapshot, after which Agent Kit calls
`createReadinessPlan()` again. This keeps named configuration, local artifact availability, remote
connectivity, and provider prerequisites in one readiness engine.

### Local artifacts

Registry declaration is not environment availability. A `published` artifact, a
`0.0.0-development` artifact, and a `declared` or `source-only` artifact all require explicit local
environment evidence before a binding becomes ready.

H7 does not include a reference npm installer. The current Registry identifies an exact package and
version but does not define a portable executable/bin selection, package integrity, lifecycle
script policy, or environment-owned installation layout. Those are the smallest additional
contracts required to install and return a deterministic executable reference safely. Until they
exist, a consumer driver may satisfy the generic local-artifact action, but Agent Kit never uses a
global install, `npm link`, a sibling workspace, a floating version, or capability-specific rules.

### Remote bindings

Preparation uses configuration **names**, binding identities, connection availability, and
provider prerequisite IDs. Secret values, bearer tokens, private endpoint values, cloud resource
IDs, subscription IDs, and tenant IDs are not accepted into a Prepared Agent Instance. A driver
can consult environment-owned secret and endpoint stores without returning their values.

### Host integration

Build remains the only host adapter generator. The host preparation request carries the generated
files to a consumer driver for validation or materialization and puts only portable paths and
content digests in the public preparation plan. Agent Kit does not choose repository ownership or
an output root.

## Prepared Agent Instance persistence

`PreparedAgentInstance` has its own schema version, currently
`PREPARED_AGENT_INSTANCE_SCHEMA_VERSION = 1`. The existing Agent Instance seam and readiness schema
remain version 1 and are unchanged. The record contains:

- deterministic `instanceId` and opaque `environmentId`;
- agent definition digest and lock digest;
- host ID and adapter schema version;
- mutable `preparedAt` and aggregate state;
- binding identity, readiness state, and prepared state.

`instanceId` is derived only from the existing immutable seam plus `environmentId`; `preparedAt`
and all readiness state are excluded. Repeated preparation of the same build, host, and environment
therefore updates the same logical instance. A different environment or lock produces a different
identity.

Use `serializePreparedAgentInstance()` for canonical JSON and
`parsePreparedAgentInstance()` for strict validation on read. Storage remains consumer-owned in H7:
no home directory, global path, database, daemon, or central fleet state is assumed. The strict
schema rejects unknown fields, and the supported preparation API never serializes generated host
content, prompt text, configuration values, endpoint values, credentials, local absolute paths, or
runtime activity.

The additive public Prepare and Prepared Agent Instance API is a material v0 feature and should be
released in the next lockstep Platform minor, **0.4.0**, after review. This repository keeps
`0.0.0-development` manifests until the tag-authoritative release workflow stamps a candidate.
