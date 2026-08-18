# Shared infrastructure

Account-neutral Bicep modules for hosting an agent tool server on Azure Container Apps.

These are **source modules**, not a deployment. This repository deploys nothing. Each module
exists so a capability repository stops maintaining its fifth slightly-different copy of the same
identity, registry, vault, workspace, and Container App definition.

## Modules

| Module                                                                     | What it owns                                                                                                                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`modules/identity.bicep`](modules/identity.bicep)                         | One user-assigned managed identity: the thing that pulls images, reads secrets, and authenticates to providers.                                              |
| [`modules/container-registry.bicep`](modules/container-registry.bicep)     | A registry with the admin user disabled, granting `AcrPull` to the workload identity.                                                                        |
| [`modules/key-vault.bicep`](modules/key-vault.bicep)                       | An RBAC vault with soft delete and purge protection, granting the workload read access and an optional seeding principal write access.                       |
| [`modules/observability.bicep`](modules/observability.bicep)               | A Log Analytics workspace, an Application Insights component backed by it, and an optional failed-request alert.                                             |
| [`modules/container-app.bicep`](modules/container-app.bicep)               | Generic Container Apps hosting: environment, ingress, probes, scale bounds, identity, registry pull, Key Vault secret references, and environment injection. |
| [`modules/storage/private-blob.bicep`](modules/storage/private-blob.bicep) | A private storage account with shared-key access disabled, one private container, an optional expiry policy, and a data-plane role assignment.               |
| [`examples/composition.bicep`](examples/composition.bicep)                 | An example wiring of all of the above. It exists so CI can prove they compose; nobody deploys it.                                                            |

## What the shared Container App module does _not_ know

The module owns hosting mechanics. It sets exactly the environment variables the platform runtime
itself reads: `NODE_ENV`, `PORT`, `HOST`, `LOG_LEVEL`, `AUTH_MODE`, `TRUST_PROXY`, the rate-limit
budgets, and the mutation policy.

It knows nothing about any capability. AST limits, jq and ripgrep ceilings, Doc RAG corpus policy,
Azure deployment settings, and Vision provider configuration are passed by the capability through
`additionalEnv`, `secretRefs`, `volumes`, and `volumeMounts`.

That boundary is the whole point. A shared module that accumulates every capability's variables is
not shared infrastructure; it is every capability's infrastructure in one file, and the next
capability has to modify it to exist.

Deliberately out of scope here and left with the capabilities that need them:

- Azure-only custom role definitions and deployment-record storage.
- Vision Content Understanding resources.
- Availability web tests and per-capability dashboards.

## Account neutrality

Every module is safe for any account to consume:

- no tenant ids, subscription ids, or resource-group names,
- no credentials, connection strings, or secret values,
- no personal or organisation-specific domains,
- the only hard-coded GUIDs are Azure **built-in role definition ids**, which are identical in
  every tenant.

`tests/infra.test.ts` enforces all of this, so a regression fails CI rather than review.

## Proxy trust is a bounded hop count, never `true`

`modules/container-app.bicep` sets `TRUST_PROXY` to a **hop count** (`trustedProxyHops`, default
`1`), not to `true`.

This matters because of how `X-Forwarded-For` actually works. A proxy **appends** to the header
rather than replacing it, so a caller can send its own `X-Forwarded-For` and Container Apps ingress
will append the real peer address after it:

```
X-Forwarded-For: <whatever the caller made up>, <real address ingress observed>
```

If the runtime trusted the whole chain, it would take the left-most entry — the value the caller
invented. The pre-auth abuse budget is keyed by address, so a hostile caller could rotate that
value on every request, land in a fresh bucket each time, and never be throttled. The abuse control
would be defeated by a header anyone can set.

A hop count of `1` tells the runtime to trust exactly one proxy, so it takes the right-most entry —
the one ingress itself added, which is the only value in the chain anything actually vouched for.

Raise `trustedProxyHops` only to match additional genuinely trusted proxies in front of Container
Apps. Never set it to `true`.

`tests/http.test.ts` proves the property directly: three requests carrying three different forged
`X-Forwarded-For` prefixes but the same appended ingress hop all land in one bucket and the third
is rejected with `429`. It also asserts that `TRUST_PROXY=1` parses as one hop rather than as a
boolean, which is the parsing mistake that would silently reintroduce the hole.

## Validation

CI builds and lints every module and the example composition:

```bash
az bicep install
az bicep build --file infra/modules/<module>.bicep --stdout
az bicep lint  --file infra/modules/<module>.bicep
```

Linting uses the repository [`bicepconfig.json`](../bicepconfig.json), which raises the core
analyzer rules to `error`. Two rules are deliberately relaxed, both for stated reasons:

- `what-if-short-circuiting` is set to `info`. Role-assignment names must be deterministic GUIDs
  derived from a principal id, and a principal id genuinely is a runtime output of the identity
  resource. The rule is an advisory about What-If prediction fidelity, not about correctness, and
  satisfying it would mean giving up deterministic role-assignment names.
- `use-recent-api-versions` and `use-stable-resource-identifiers` are off, because they churn on a
  schedule rather than on a change and would turn every unrelated pull request red.

No deployment is performed. `az deployment group validate` needs a real subscription, so the gate
CI can honestly run is build and lint.

---

## Distribution to capability repositories is **unresolved**

This is called out deliberately: **no distribution mechanism has been chosen**, and this pull
request does not choose one.

Concretely, this repository has **not**:

- introduced Git submodules,
- copied the modules back into any capability repository,
- assumed a private Bicep registry exists,
- published the modules to any registry.

### Candidate mechanisms

**1. Versioned Bicep registry modules**

Publish each module to an OCI-backed Bicep module registry and consume it by version:

```bicep
module identity 'br:<registry>/bicep/agent-tool-platform/identity:0.1.0' = { ... }
```

_For:_ first-class Bicep support, real version pinning, no build-time copying.
_Against:_ requires a registry to exist and to be reachable by every consumer's deployment
identity, which is a new piece of shared infrastructure with its own access story.

**2. Bicep files shipped inside a versioned package**

Ship the `.bicep` files in the npm package a capability already depends on, and reference them
through the installed path.

_For:_ one dependency graph, one version number, no new infrastructure.
_Against:_ couples infrastructure versioning to package versioning, and Bicep paths into
`node_modules` are awkward and easy to break.

**3. Release artifacts acquired during build or bootstrap**

Attach a tarball of `infra/modules` to each GitHub release and fetch it during deployment
bootstrap.

_For:_ no registry, no package coupling, works for non-Node consumers.
_Against:_ consumers need a fetch-and-verify step, and integrity checking becomes their problem.

### What must be true before the decision is made

- AST Summarizer, the first real consumer, has actually migrated and revealed which parameters it
  genuinely needs.
- At least two capabilities are consuming the modules, so the versioning story is tested by more
  than one caller.
- The consumption path works from both CI and a developer machine without hand-configured
  credentials.

Until then, capability repositories keep their own `infra/` and these modules are the reference
implementation those will converge on.
