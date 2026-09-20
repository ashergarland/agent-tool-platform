# @agent-tool-platform/capability-registry

Versioned, account-neutral capability metadata for Agent Tool Platform. This package owns the
registry schema, deterministic first-party data, validation, optional source-checkout drift checks,
and a small read API for consumers such as `@agent-tool-platform/agent-kit`.

It describes **capabilities**, not individual MCP tools. Tool input/output schemas and domain
behavior remain authoritative in each capability repository.

The package is private and unpublished in this Hackathon slice. Its checked-in JSON data and TypeScript
API are consumed from the Platform workspace; no runtime network registry is required.

## Contents

- `schemas/v1/` — generated Draft 2020-12 entry and registry schemas;
- `data/entries/` — reviewable source entries for the seven first-party capabilities;
- `data/first-party-registry.json` — deterministic generated registry;
- `src/validation.ts` — schema, reference, mutation, ordering, and account-neutral validation;
- `src/source-validation.ts` — optional verification against explicitly supplied checkouts; and
- `src/registry.ts` — enumeration and lookup functions.

## Consumer API

```ts
import {
  createCapabilityRegistryReader,
  loadFirstPartyCapabilityRegistry,
} from '@agent-tool-platform/capability-registry';

const registry = await loadFirstPartyCapabilityRegistry();
const reader = createCapabilityRegistryReader(registry);

const capabilities = reader.listCapabilities();
const vision = reader.getCapability('vision');
const profiles = reader.listProfiles('vision');
const bindings = reader.listBindings('vision');
```

The seam exposes identity, version/artifact status, display metadata, routing summary, tool count,
profiles, bindings, six execution dimensions, permissions, prerequisites, readiness signals,
mutation effects, and conformance. It does not resolve versions, choose a binding, generate a
lockfile, create an adapter, or compose an agent.

Dependency direction is one-way: Agent Kit may consume this package; this package does not depend
on Agent Kit.

## Profile and binding model

Every profile uses the Platform's existing six-dimensional deployment contract:

| Dimension   | Values                                                              |
| ----------- | ------------------------------------------------------------------- |
| `execution` | `local`, `hosted`                                                   |
| `delivery`  | `source`, `package`, `container`                                    |
| `access`    | `local-process`, `authenticated-service`                            |
| `workload`  | `none`, `filesystem`, `mount`, `upload`, `object-store`, `provider` |
| `provider`  | `none`, `external`                                                  |
| `mutation`  | `read-only`, `mutating`                                             |

A capability can expose multiple profiles. Bindings refer to a profile and artifact, then state the
interface and whether that combination is local, remote, or hybrid. Capability identity is never
collapsed into one execution location. The package has no Runtime dependency; a cross-package
regression test keeps this schema vocabulary identical to Runtime's deployment contract while
preserving independent package builds.

Six entries normalize their authoritative `capability-profiles.json`. AST Summarizer predates that
declaration, so its local profile is marked `registry-curated` and references its pinned
server/package/release metadata instead of pretending a source declaration exists.

## Validation

From the repository root:

```powershell
npm run registry:schemas
npm run registry:generate
npm run registry:validate
```

Normal validation is deterministic and offline. It rejects unsupported schema versions, duplicate
identities, malformed versions/artifacts/profiles, invalid profile or artifact references,
six-dimension mismatches, inconsistent mutation effects, stale generated output, and
account-specific/private data.

Optional development/CI drift checks receive explicit local checkout paths and do not fetch:

```powershell
npm run registry:verify-sources -- `
  "ast-summarizer=C:\path\to\agent-tool-server-ast-summarizer" `
  "vision=C:\path\to\agent-tool-server-vision"
```

The command requires a checkout for every registry entry. It verifies pinned revisions,
server/package identity and version metadata, tag-stamped release versions, artifact declarations,
and normalized source profiles. No local paths are written into registry data.

## Public/private boundary

Registry entries contain reusable product metadata only. Validation rejects account identifiers,
Azure resource IDs, secret assignments, private keys, local user paths, private IP endpoints,
localhost, and private/internal hostnames. Secret **names** and generic provider prerequisites are
allowed; secret values, tenant/subscription/client IDs, private endpoints, and operator desired
state belong in private Prepare/live state.
