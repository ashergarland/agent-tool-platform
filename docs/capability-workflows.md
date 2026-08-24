# Reusable capability workflows

`agent-tool-platform` owns the common development and release mechanics for thin TypeScript
capabilities. Capability repositories keep domain-specific integration and deployment checks. The
AST Summarizer proved this split, but the contracts below are generic and do not encode AST paths,
tools, fixtures, containers, or infrastructure.

Call reusable workflows with an immutable platform commit SHA or immutable release tag. Do not use
`@main` for production CI, security, or release automation: changing this repository must not
silently change every capability's gates.

## Capability repository contract

The common workflows expect these root scripts:

```text
format:check
lint
typecheck
test:coverage
build
openapi:emit
metadata:validate
```

Publication-ready packages must also provide `package:smoke`. CI can opt into that gate; release
always requires it. A smoke test should pack the package, install it into a temporary external
consumer, and exercise its public entry points.

Thin capability repositories should also commit this line-ending contract so Windows checkouts do
not make Prettier observe CRLF-only changes:

```gitattributes
* text=auto eol=lf
```

## Common CI

[`capability-ci.yml`](../.github/workflows/capability-ci.yml) checks out the caller repository and
runs, in order:

```text
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run openapi:emit
npm run metadata:validate
```

It uploads the generated OpenAPI document and uploads `coverage/lcov.info` when present. Its
`workflow_call` inputs are:

| Input               | Type      | Default          | Meaning                                       |
| ------------------- | --------- | ---------------- | --------------------------------------------- |
| `node_version`      | `string`  | `"22"`           | Capability runtime used for validation.       |
| `openapi_path`      | `string`  | `"openapi.json"` | File emitted by `openapi:emit`.               |
| `run_package_smoke` | `boolean` | `false`          | Require `npm run package:smoke` when enabled. |

`run_package_smoke` is not an `--if-present` convenience. Enabling it requires the script to exist
and pass.

Example caller:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  capability:
    permissions:
      contents: read
    uses: ashergarland/agent-tool-platform/.github/workflows/capability-ci.yml@<immutable-ref>
    with:
      openapi_path: openapi.json
      run_package_smoke: false

  domain-integration:
    needs: capability
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: npm run test:integration
```

The reusable job deliberately does not pass `repository` to `actions/checkout`. GitHub therefore
checks out the caller capability, which is the required reusable-workflow behavior.

Container images, domain fixtures, tool invocations, path-boundary assertions, and capability
infrastructure remain in `domain-integration`-style caller jobs. Shared baseline goes up; domain
integration remains local.

## Common security

[`capability-security.yml`](../.github/workflows/capability-security.yml) has three jobs:

1. **Dependency audit** installs with Node 22, blocks on high-or-higher runtime dependency
   vulnerabilities, and reports development critical advisories without blocking.
2. **Secret scanning** checks out full history and runs gitleaks with only the normal GitHub token.
3. **CodeQL** analyzes JavaScript/TypeScript and publishes results with CodeQL v4.

The reusable workflow has no inputs, requires no repository secrets, and does not require a
capability-specific CodeQL configuration.

Reusable workflows cannot elevate permissions granted by their callers. A security caller must
grant these permissions at both the workflow and calling-job boundary:

```yaml
name: Security

on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: '19 4 * * 1'

permissions:
  contents: read
  security-events: write
  packages: read

jobs:
  capability-security:
    permissions:
      contents: read
      security-events: write
      packages: read
    uses: ashergarland/agent-tool-platform/.github/workflows/capability-security.yml@<immutable-ref>
```

The caller owns push, pull-request, and recurring schedule policy. The called workflow exposes only
`workflow_call`. Do not add `secrets: inherit`; the shared security workflow does not need it.
Internally, dependency audit and secret scanning narrow themselves to `contents: read`, while
CodeQL receives `contents: read`, `security-events: write`, and `packages: read`.

## Single-package capability release

[`capability-release.yml`](../.github/workflows/capability-release.yml) is the normal
**post-bootstrap** release path for one public npm package at the caller repository root. It is not
the release workflow for this platform's runtime/testkit pair.

The v1 contract requires:

- one package at repository root and no npm workspaces;
- a non-private, valid npm package name;
- `package.json` repository metadata that identifies the caller GitHub repository;
- checked-in `package.json`, root `package-lock.json`, and `server.json` versions of
  `0.0.0-development`, with one matching npm package declaration in `server.json`;
- a lockfile consistent enough for `npm ci`;
- every standard capability quality script plus mandatory `package:smoke`; and
- a Git tag on the caller's default-branch history.

The release `workflow_call` inputs are:

| Input                    | Type      | Default | Meaning                                                    |
| ------------------------ | --------- | ------- | ---------------------------------------------------------- |
| `version`                | `string`  | `""`    | Exact version for manual dry-run or recovery.              |
| `dry_run`                | `boolean` | `false` | Validate and run `npm publish --dry-run`.                  |
| `recover_github_release` | `boolean` | `false` | Repair only missing post-publication GitHub Release state. |

Normal publication ignores manual version selection and derives the package version from a pushed
stable-semver `vX.Y.Z` tag. Prerelease and build-metadata tags are not part of the initial contract;
supporting them safely would require an explicit npm distribution-tag policy. The tagged commit
must belong to the caller's default-branch history. On the runner, the workflow installs pinned npm
11.19.0 and then uses:

```bash
npm ci
npm version "$VERSION" --no-git-tag-version --ignore-scripts
```

The second command updates the root manifest and lockfile ephemerally. The workflow then stamps
`server.json` and its matching npm package declaration, and records the release commit as the packed
manifest's `gitHead`. It verifies the stamped identity and allows only `package.json`,
`package-lock.json`, and `server.json` to change during stamping. Nothing is committed or pushed
back.

Before publication it runs:

```text
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run openapi:emit
npm run metadata:validate
npm run package:smoke
```

It then creates one exact tarball with `npm pack --ignore-scripts`, checks that tarball identifies
the root package and stamped version, and publishes that same file. Publishing a tarball prevents
npm lifecycle hooks from changing the candidate after validation.

The registry check distinguishes a true `E404` from network, authentication, and other failures.
Only a confirmed absent version can follow the normal path. An existing version is never
overwritten, and ambiguous registry state fails closed. Every registry read and write explicitly
targets `https://registry.npmjs.org`, including a scoped-registry override, and conflicting
`publishConfig` registry, access, or distribution-tag values are rejected. Publication uses
`npm publish --access public` with the validated tarball and disabled lifecycle scripts through npm
Trusted Publishing/OIDC. After publication, the workflow waits for the exact version and verifies
its `gitHead`, GitHub repository metadata, and integrity digest. Only then does it create the GitHub
Release with generated notes.

### Publish caller

The caller owns the tag and manual triggers:

```yaml
name: Publish

on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:
    inputs:
      version:
        description: 'Exact version to validate or recover'
        required: true
        type: string
      dry_run:
        description: 'Validate without publishing'
        required: false
        default: true
        type: boolean
      recover_github_release:
        description: 'Create a missing release for an existing npm version'
        required: false
        default: false
        type: boolean

permissions:
  contents: write
  id-token: write

jobs:
  publish:
    permissions:
      contents: write
      id-token: write
    uses: ashergarland/agent-tool-platform/.github/workflows/capability-release.yml@<immutable-ref>
    with:
      version: ${{ inputs.version || '' }}
      dry_run: ${{ github.event_name == 'workflow_dispatch' && inputs.dry_run || false }}
      recover_github_release: ${{ github.event_name == 'workflow_dispatch' && inputs.recover_github_release || false }}
```

Both the caller workflow/job and reusable workflow/job must grant `id-token: write`. The reusable
workflow also needs `contents: write` to create the GitHub Release. It requires no long-lived npm
publishing credential and callers must not add one.

### Trusted Publishing identity

npm validates the **calling workflow identity** when publication occurs through `workflow_call`.
For a capability in `owner/example-capability` whose tiny caller is
`.github/workflows/publish.yml`, configure the npm Trusted Publisher as:

```text
repository: owner/example-capability
workflow filename: publish.yml
```

Do not configure the publisher against `agent-tool-platform` or `capability-release.yml`. The
caller filename is an npm-side identity and must stay aligned with the capability repository.
Trusted Publishing preserves automatic provenance.

### Manual validation and recovery

`workflow_dispatch` cannot perform an ordinary publication. It can do one of two explicit actions:

- `dry_run: true` runs the complete candidate validation and `npm publish --dry-run`; or
- `recover_github_release: true` with `dry_run: false` repairs a missing GitHub Release after npm
  publication succeeded.

Recovery checks out the existing release tag, proves it belongs to default-branch history, and
requires npm metadata for the exact version to identify the same Git commit and caller repository.
It skips dependency installation and candidate quality gates because it cannot change the package
that is already on npm, and it never executes the publication step. If npm metadata lacks enough
identity to prove that link, recovery fails closed; a maintainer must investigate rather than use a
force escape hatch. An existing GitHub Release is left unchanged.

### First publication

This reusable workflow does not bootstrap a package that does not yet exist on npm. npm Trusted
Publisher configuration requires the package to exist first. The capability's initial publication,
public name, package contents, and Trusted Publisher setup must be completed deliberately in that
capability's adoption work. Do not add token-based bootstrap secrets to this reusable workflow.
After bootstrap and Trusted Publisher configuration, pushed version tags are the authoritative
normal release path:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```
