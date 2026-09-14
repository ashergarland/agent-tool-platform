# Deployment contract v1

The deployment contract connects a public capability profile to one private deployment instance
without making the Platform a deployer, provider client, or policy engine. Validation is local and
deterministic: it reads JSON files, performs no network calls, and needs no cloud credentials.

## Documents and ownership

| Document or state                          | Owner                   | Contents                                                                                        |
| ------------------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------- |
| `capability-profile-declaration`           | Public capability Git   | Account-neutral profile support, interfaces, schema references, secret names, and expectations. |
| `deployment-instance`                      | Private operator Git    | Exact non-secret desired state, immutable declaration/source/artifact pins, and references.     |
| Secret values                              | Provider secret store   | Values only. Desired Git contains names and provider references, never values.                  |
| Observed status, drift, and build evidence | Operator evidence store | Produced digests, attestations, rollout results, status, and drift.                             |

The public declaration must not contain tenant/subscription/account identifiers, live resource
names, production endpoints or recipients, secret values, or canonical operator environments.
Private operator Git may contain exact non-secret account-specific references. Neither desired
document may contain observed/generated evidence.

Both v1 documents use `contractVersion: 1`. Unknown versions and kinds fail closed.

## Canonical declaration discovery

A capability repository that supports this contract places exactly one public declaration at:

```text
capability-profiles.json
```

The path is repository-root relative and case-sensitive. Discovery means looking only for that
file; there is no registry lookup or recursive search. A private instance still identifies the
declaration by all three immutable coordinates:

```json
{
  "repository": "https://code.invalid/safe-capability.git",
  "revision": "1111111111111111111111111111111111111111",
  "path": "capability-profiles.json"
}
```

The full Git SHA is authoritative. A validator can prove the reference is complete and compare the
repository/path to the supplied declaration offline; the operator must obtain the file from the
pinned commit before validation.

## Profile dimensions

Every named profile declares exactly one value for all six dimensions:

| Dimension   | Values                                                              |
| ----------- | ------------------------------------------------------------------- |
| `execution` | `local`, `hosted`                                                   |
| `delivery`  | `source`, `package`, `container`                                    |
| `access`    | `local-process`, `authenticated-service`                            |
| `workload`  | `none`, `filesystem`, `mount`, `upload`, `object-store`, `provider` |
| `provider`  | `none`, `external`                                                  |
| `mutation`  | `read-only`, `mutating`                                             |

A hybrid capability adds named profiles; it does not combine dimensions implicitly. The instance
copies the selected dimensions, and cross-validation requires an exact match with the named public
profile. Local profiles therefore do not inherit hosted probes, provider identity, or cloud
requirements merely because another profile supports them.

The declaration also identifies:

- supported delivery forms, installable/buildable identity, entrypoint, deployment mechanics, and
  provenance;
- a capability-owned public non-secret configuration schema and whether configuration is bounded;
- required secret **names**, provider prerequisites, trust boundary, and RBAC expectations;
- workload and mutation expectations when selected;
- supported verification surfaces; and
- capability-owned extension schema references.

## Immutable desired state

Declaration and deployed source pins are independent:

```text
declaration.repository + declaration.revision + declaration.path
source.repository      + source.revision      + source.path
```

Changing the declaration SHA does not change the deployed source SHA. Each revision must be a full
lowercase 40-character Git SHA; branch names and tags are rejected.

Prebuilt package and container selections include an exact identity, a `sha256:` digest, and a
source binding whose revision equals the deployed source pin. A package version must be exact, not
`latest`, a range, or another mutable selector.

A build-from-source selection is different:

- desired state pins the exact source, build entrypoint, expected artifact kind, and provenance
  mechanism;
- desired state requires produced-digest and source-binding evidence before rollout;
- desired state does **not** contain a digest for an artifact that has not been built; and
- the produced digest and its source binding belong in observed evidence after the build.

The declaration pin, source pin, prebuilt artifact digest, and any rollback target remain desired
state. Process status, drift, a build's produced digest, and rollout evidence do not.

## Conditional requirements

Requirements compose from the selected dimensions:

| Selection                        | Additional required contract                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Local execution/package delivery | Installable or buildable identity, entrypoint, local trust boundary, provenance, and behavior/version expectations.                          |
| Hosted execution                 | Authenticated access, service identity, bounded configuration, readiness, source-version identity, artifact-evidence rollout gate, rollback. |
| Non-`none` workload              | Explicit source and data interface, authorization scope/reference, lifecycle/freshness/cleanup, deterministic `not-ready` absence behavior.  |
| External provider                | Declared provider prerequisites, external secret references, scoped identity/RBAC, and provider readiness separate from process readiness.   |
| Mutating profile                 | Default-disabled separate enablement, authorization, confirmation, declared durable record when required, and authoritative verification.    |

Every instance includes identity/readiness/version/behavior/provider/provenance expectation arrays.
Only surfaces supported and required by the selected profile must be non-empty. Keeping provider
readiness separate prevents process liveness from being mistaken for usable provider access.

Rollback is either an immutable target or an explicit operator strategy. It is desired intent, not
proof that rollback succeeded.

## Capability extensions

The public profile may list `extensionSchemas`. Each reference contains an absolute schema ID, the
same capability ID as the declaration, and a repository-relative schema path. An instance may then
provide an extension envelope containing that exact reference plus JSON parameters.

Platform validation verifies ownership and that the selected public profile declared the exact
schema reference. It rejects secret values and observed evidence in the envelope, but it does not
interpret capability-domain parameters. The capability owns and validates those semantics.

## Offline CLI

Build the runtime, then validate either the public declaration alone or a declaration/instance
pair:

```bash
npm run build

node packages/runtime/bin/validate-deployment.js \
  --declaration capability-profiles.json

node packages/runtime/bin/validate-deployment.js \
  --declaration capability-profiles.json \
  --instance operator/deployment-instance.json
```

The installed command is `agent-tool-validate-deployment`. Invalid JSON, unknown arguments, schema
failures, conditional failures, and cross-document failures are written to stderr and return a
non-zero status. Validation never contacts the declaration repository, provider, secret store, or
deployment target.

Programmatic consumers can import `validateCapabilityProfileDeclaration`,
`validateDeploymentInstance`, `validateDeploymentContract`, their assertion variants, and both
schema objects from `@agent-tool-platform/runtime/deployment`.

The npm artifact also ships the standalone Draft 2020-12 schemas at:

```text
schemas/deployment/v1/capability-profile-declaration.schema.json
schemas/deployment/v1/deployment-instance.schema.json
```

They are exported as
`@agent-tool-platform/runtime/deployment/schemas/capability-profile-declaration-v1.json` and
`@agent-tool-platform/runtime/deployment/schemas/deployment-instance-v1.json`.

## Source-checkout consumption before a release

A downstream repository can pin a reviewed Platform commit without using an unpublished branch or
waiting for an npm release:

```bash
git clone https://github.com/ashergarland/agent-tool-platform.git
cd agent-tool-platform
PLATFORM_SHA="<reviewed-40-character-platform-sha>"
git checkout --detach "$PLATFORM_SHA"
test "$(git rev-parse HEAD)" = "$PLATFORM_SHA"

# Use Node 22.
npm ci
npm run build
node packages/runtime/bin/validate-deployment.js \
  --declaration /path/to/capability-profiles.json \
  --instance /path/to/deployment-instance.json
```

The reviewed full SHA, not a mutable branch name, is the dependency identity. No Platform package
publication is required.

## Testkit conformance

Capability repositories can run the same validator through the testkit:

```ts
import { runDeploymentContractConformance } from '@agent-tool-platform/testkit/deployment';

runDeploymentContractConformance({
  declaration,
  instance,
});
```

The suite validates the supplied documents and proves that corrupted contract versions, undeclared
profiles, secret value fields, and observed evidence fail. It imports the runtime validator rather
than maintaining a second implementation.

Account-neutral reference fixtures for local/package, hosted/provider, and filesystem/data profiles
are under `tests/fixtures/deployment/`.
