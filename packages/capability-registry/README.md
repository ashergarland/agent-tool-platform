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

Registry schema `1.1.0` historically added an optional binding-level HTTP client contract. That
shape addition remained in the `schemas/v1/` major-version path because bindings that did not
require request metadata needed no new field. Registry documents still carry an exact schema
version; the current `1.2.0` parser behavior is described below.

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

### Local executable artifacts

Registry schema `1.2.0` adds the optional, versioned `localExecution` contract to npm artifacts.
The artifact shape change is additive: an older artifact shape without `localExecution` can be
represented in a schema-`1.2.0` document, but it is not materializable through the v1 reference
materializer. This is not a multi-version reader: the current parser requires document
`schemaVersion: "1.2.0"` and rejects a complete `1.1.0` document.

```json
{
  "kind": "npm",
  "identifier": "@example/capability",
  "version": "1.2.3",
  "availability": "published",
  "localExecution": {
    "schemaVersion": 1,
    "kind": "node-package-bin",
    "bin": "example-capability",
    "integrity": "sha512-...",
    "lifecycleScripts": "forbidden"
  }
}
```

The package name and exact version identify the npm artifact. `bin` selects one exact executable;
consumers must not guess the package name, choose the first bin, or inspect host shims to infer it.
The v1 executable kind is intentionally narrow: it describes a Node npm-package bin, not a generic
arbitrary command.

`integrity` is one canonical SHA-512 Subresource Integrity value matching npm's published tarball
integrity. It is distinct from both `source.revision` (the source Git commit) and Agent Kit's
Registry-entry digest (the consumed metadata record). A non-published artifact may declare the
future bin and lifecycle policy, but validation rejects immutable integrity on `declared` or
`source-only` availability. No integrity is fabricated for unpublished packages.

Artifact availability and environment materializability are separate:

- `published` means a distribution artifact is declared as published; it does not mean installed;
- a v1 npm artifact is materializable only when it is published and carries the exact bin,
  canonical integrity, and `lifecycleScripts: "forbidden"` contract; and
- environment readiness is established later by Agent Kit Prepare from verified realization
  evidence.

The first-party AST Summarizer entry carries authoritative npm `0.1.1` bin and tarball integrity
metadata. The five unpublished flagship npm entries remain declared/development artifacts and do
not become materializable through this schema addition.

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
effects, malformed executable selections or npm integrity, stale generated output, and
account-specific/private data.

Optional development/CI drift checks receive explicit local checkout paths and do not fetch:

```powershell
npm run registry:verify-sources -- `
  "ast-summarizer=C:\path\to\agent-tool-server-ast-summarizer" `
  "vision=C:\path\to\agent-tool-server-vision"
```

The command verifies each supplied checkout against its registry entry. Supplying every registry
entry performs a complete source drift check. It verifies pinned revisions, server/package identity
and version metadata, tag-stamped release versions, artifact declarations, and normalized source
profiles. When local execution metadata is present, it also checks that source package metadata
declares the selected bin. npm tarball integrity is registry-distribution evidence and is therefore
not derived from or equated with the source Git revision. No local paths are written into registry
data.

## Public/private boundary

Registry entries contain reusable product metadata only. Validation rejects account identifiers,
Azure resource IDs, secret assignments, private keys, local user paths, private IP endpoints,
localhost, and private/internal hostnames. Secret **names** and generic provider prerequisites are
allowed, as are generic header names and safe literal prefixes. Secret values,
tenant/subscription/client IDs, private endpoints, and operator desired state belong in private
Prepare/live state.
