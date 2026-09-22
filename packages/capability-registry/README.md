# @agent-tool-platform/capability-registry

Versioned, account-neutral capability metadata for Agent Tool Platform. This package owns the
registry schema, deterministic first-party data, validation, optional source-checkout drift checks,
and a small read API for consumers such as `@agent-tool-platform/agent-kit`.

It describes **capabilities**, not individual MCP tools. Tool input/output schemas and domain
behavior remain authoritative in each capability repository.

The package is prepared for public npm distribution but has not completed its one-time bootstrap.
Its checked-in manifest deliberately remains private; release stamping removes that guard only in
an ephemeral candidate. After bootstrap, consumers install the exact Platform release:

```bash
npm install @agent-tool-platform/capability-registry@X.Y.Z
```

No runtime network registry is required; the versioned package carries its static data.

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
mutation effects, optional HTTP client request mappings, and conformance. It does not resolve
versions, choose a binding, generate a lockfile, create an adapter, or compose an agent.

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

### HTTP client request mappings

Registry schema `1.1.0` adds an optional binding-level HTTP client contract. The schema remains in
the `schemas/v1/` major-version path because this is a backward-compatible minor addition for
bindings that do not require request metadata.

An HTTP binding can map a named profile configuration requirement to one or more request headers:

```json
{
  "client": {
    "http": {
      "headers": [
        {
          "name": "Authorization",
          "value": {
            "source": "configuration",
            "name": "access-token",
            "prefix": "Bearer "
          }
        }
      ]
    }
  }
}
```

The mapping contains the configuration **name**, never its value. Header names use a bounded
RFC-token-compatible form. Names are unique case-insensitively; declared casing is preserved in
public and generated output, while normalization orders headers by their lowercase name and then
their declared name. A prefix is an optional, bounded printable-ASCII literal. It cannot contain
CR, LF, control characters, or variable interpolation.

Mappings are valid only on `http` interfaces, and every referenced configuration must appear in
the selected profile's `prerequisites.requiredSecrets`. A remote HTTP binding must map every
required configuration explicitly. Unauthenticated remote HTTP bindings need no mapping. This
fail-closed rule prevents a host from guessing `Authorization`, `x-api-key`, `Bearer`, or any other
transport semantics from a configuration name.

The Registry owns this metadata because a binding joins a profile requirement to a concrete
transport. Profiles continue to describe what configuration and preparation are required without
embedding host behavior. Host adapters consume the validated mapping through Agent Kit and may
accept it only when they can represent it faithfully.

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
six-dimension mismatches, incomplete or invalid HTTP client mappings, inconsistent mutation
effects, stale generated output, and account-specific/private data.

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
allowed, as are generic header names and safe literal prefixes. Secret values,
tenant/subscription/client IDs, private endpoints, and operator desired state belong in private
Prepare/live state.
