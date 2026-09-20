# @agent-tool-platform/agent-kit

The host-neutral composition engine beneath Agent Builder.

Agent Kit converts a canonical agent definition into a validated, reproducible build. It resolves
capability releases through a narrow registry reader, selects a compatible six-dimensional
capability profile, generates `agent.lock`, composes bounded instructions, produces a readiness
plan, and delegates host files to an adapter.

The package and its sibling first-party registry are prepared for public npm distribution but have
not completed their one-time bootstrap. Their checked-in manifests deliberately stay private;
release stamping removes those guards only in an ephemeral candidate. After bootstrap, an agent
composition repository installs the exact lockstep Platform release:

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
- the stable identity seam later Prepare and Agent Instance work can extend.

It does not execute capability tools, deploy providers, store registry data, collect telemetry, or
manage running instances.

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
build.instanceIdentity; // stable seam for a later environment-specific instance
```

The VS Code adapter uses exact package versions for local stdio servers and input placeholders for
remote endpoints or local secret values. Declared-but-unpublished packages use offline launch mode
and remain a Prepare requirement. An authenticated remote binding is incompatible until the
registry contract provides an explicit client-header mapping; Agent Kit does not guess one from a
secret name. Values, endpoints, credentials, absolute local paths, and live provider identifiers
never enter `agent.lock`.

## Readiness

Readiness is a plan, not a liveness probe. It distinguishes:

- locally available bindings;
- local setup still required;
- remote or provider setup still required;
- missing named configuration;
- incompatible bindings.

An installed local binding can be ready while its process is inactive. Runtime and provider health
remain later Prepare/management concerns.
