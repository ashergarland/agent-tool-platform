# Releasing

Two packages are distributed from this repository:

- `@agent-tool-platform/runtime`
- `@agent-tool-platform/testkit`

Both are public, both target the primary npm registry, and for v0 both are versioned in **lockstep**:
the testkit declares an exact dependency on the runtime at the same version. `npm run release:check`
enforces that, and it is part of normal CI.

> **Bootstrap complete.** Runtime and testkit 0.1.0 were published in August 2026. npm Trusted
> Publishing is configured for both packages. Normal releases now run from intentional `v*` tags;
> ordinary pushes, pull requests, and merges never publish.

The manual bootstrap below is retained as historical documentation. It was a one-time process and
must not be repeated for later versions.

---

## A. Completed one-time bootstrap for 0.1.0 (August 2026)

npm cannot attach a Trusted Publisher to a package that does not exist. So the first release of each
package had to be published by a maintainer from a local machine before OIDC publishing could be
configured. These are the steps that were used for 0.1.0; they are not the release path now.

### Prerequisites

1. The npm organization `agent-tool-platform` exists, and you are a member with publish rights to it.
   Create it at <https://www.npmjs.com/org/create> if it does not exist yet.
2. Two-factor authentication is enabled on your npm account.
3. You are logged in locally:

   ```bash
   npm login
   npm whoami
   ```

   `npm whoami` must print your npm username. If it errors, you are not authenticated and nothing
   below will work.

4. You are on the default branch, with a clean tree, at the exact commit you intend to ship:

   ```bash
   git switch main
   git pull
   git status --short   # must be empty
   ```

Never put a token in a file in this repository. `npm login` stores credentials in your user-level
`~/.npmrc`, which is outside the repository.

### Validate everything first

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run package:smoke
npm run release:check
npm run metadata:validate
```

`package:smoke` packs both tarballs and installs them into throwaway projects outside this
repository, so a failure there is a failure a consumer would have hit.

### Publish the runtime FIRST

```bash
npm publish --workspace @agent-tool-platform/runtime --access public
```

Verify it is actually on the registry before continuing:

```bash
npm view @agent-tool-platform/runtime@0.1.0 version
```

> **Order matters. Do not publish the testkit first.** The testkit declares
> `"@agent-tool-platform/runtime": "0.1.0"` as a normal registry dependency. If the testkit is
> published while that runtime version does not exist, the testkit is **temporarily uninstallable**:
> every `npm install` of it fails to resolve its dependency until `@agent-tool-platform/runtime@0.1.0`
> is itself published, at which point existing installs start working with no change to the testkit.
>
> It is recoverable, not fatal — but it is a window in which the package on npm is broken for anyone
> who tries it, and it cannot be tidied away afterwards, because the published version cannot be
> withdrawn or overwritten. Publishing the runtime first avoids the window entirely.

### Publish the testkit SECOND

```bash
npm publish --workspace @agent-tool-platform/testkit --access public
```

Verify:

```bash
npm view @agent-tool-platform/testkit@0.1.0 version
npm view @agent-tool-platform/testkit@0.1.0 dependencies
```

The second command must show `@agent-tool-platform/runtime: 0.1.0`.

### Completed repository transition

After 0.1.0 was published, the package READMEs and repository status were updated to show supported
npm installation, and the pre-publication-only assertions in `scripts/validate-metadata.ts` and
`tests/packaging.test.ts` were replaced with durable metadata, documentation, and workflow
invariants. Package manifests remained at 0.1.0 throughout this transition.

---

## B. Normal releases through Trusted Publishing

Once both packages exist on npm, publishing moves into GitHub Actions using OIDC. No long-lived npm
write token is created, stored in GitHub secrets, or referenced by the workflow.

### Trusted Publisher configuration

This npm-side setup has been completed **once per package**. npm scopes a Trusted Publisher to a
single package, so both packages have the following configuration:

| Field                    | Value                 |
| ------------------------ | --------------------- |
| Provider                 | GitHub Actions        |
| GitHub organization/user | `ashergarland`        |
| Repository               | `agent-tool-platform` |
| Workflow filename        | `publish.yml`         |
| Environment              | (leave empty)         |
| Allowed action           | `npm publish`         |

Every field is case-sensitive and must match exactly, including the `.yml` extension. Renaming
`publish.yml` breaks publishing until the npm configuration is updated to match.

The workflow also satisfies npm's runner and repository requirements:

- publication must run on a GitHub-hosted runner (self-hosted runners are not accepted),
- each package's `repository.url` must match this GitHub repository, which `release:check` asserts.

### Run a release

1. Merge the version change to the default branch. This workflow never bumps a version.
2. Create and push a tag whose name is `v` followed by that exact version, for example `v0.1.1`.
3. The Publish workflow verifies that the tagged commit is in the default branch history, validates
   the tag against every manifest and the testkit's exact runtime dependency, and runs format, lint,
   typecheck, coverage, build, package smoke, `release:check`, and metadata validation.
4. After confirming both versions are absent from npm, it publishes runtime, waits with bounded
   retries until that exact version resolves, publishes testkit, and verifies its version and runtime
   dependency from the registry.

`workflow_dispatch` is available from the default branch for a deliberate dry run or recovery. It
requires an explicit version that exactly matches all manifests. A dispatch without `dry_run` is a
real publication operation, not a substitute for the normal tag path.

### Why no token

GitHub Actions mints a short-lived OIDC token for the job (`id-token: write`), and the npm CLI
exchanges it for a scoped, short-lived publish credential. There is nothing to rotate and nothing to
leak. `NODE_AUTH_TOKEN` is deliberately absent from the workflow, and no `NPM_TOKEN` secret exists or
should be created.

Trusted publishing also produces provenance attestations automatically, without `--provenance`.

### Recommended hardening, after OIDC publishing is proven

Once a release has actually gone out through the workflow, tighten each package on npmjs.com:
**Settings → Publishing access → "Require two-factor authentication and disallow tokens"**. The
Trusted Publisher keeps working, because OIDC is not token authentication; what this removes is the
long-lived-token path that nobody is using any more.

---

## If a release goes out partially

The runtime publishes before the testkit, so the failure mode with consequences is: runtime
published, testkit not. The workflow detects this registry state and refuses to treat it as a normal
release. Recover through `workflow_dispatch` from the default branch with the same version and the
explicit testkit-only recovery option. The workflow verifies that runtime exists, testkit does not,
and the manifests still agree before publishing only the testkit.

Do not bump the testkit independently to "get around" the failure: for v0 the versions are locked
together and the testkit's runtime dependency is exact, so an independent bump produces a pair that
`release:check` rejects and consumers cannot reason about.

Do not use `npm publish --force`, and do not try to overwrite or re-upload a version. npm versions
are immutable. If a published version is genuinely broken, deprecate it and release a new one:

```bash
npm deprecate @agent-tool-platform/runtime@0.1.0 "Broken release; use 0.1.1"
```

---

## Version policy for v0

- Runtime and testkit share one version number.
- The testkit's runtime dependency is exact, never a range.
- Nothing bumps versions automatically. There is no Changesets, semantic-release, or Lerna
  publishing here, on purpose: two packages released together do not need a release framework.
- To cut a new version, change both `version` fields and the testkit's runtime dependency in one
  commit, then let `release:check` confirm the three values agree.
