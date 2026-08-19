# Releasing

Two packages are distributed from this repository:

- `@agent-tool-platform/runtime`
- `@agent-tool-platform/testkit`

Both are public, both target the primary npm registry, and for v0 both are versioned in **lockstep**:
the testkit declares an exact dependency on the runtime at the same version. `npm run release:check`
enforces that, and it is part of normal CI.

> **Neither package has been published yet.** Everything below describes how to publish, not
> something that has already happened. Nothing in this repository publishes on merge, on tag, or on
> any push: `.github/workflows/publish.yml` is `workflow_dispatch` only, and it is the only file in
> the repository that contains a publish command.

There are two flows, and they are not interchangeable. The first one happens exactly once per
package.

---

## A. One-time bootstrap for 0.1.0

npm cannot attach a Trusted Publisher to a package that does not exist. So the first release of each
package is published by a maintainer from a local machine, and only afterwards can OIDC publishing be
configured.

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

### After publishing: the one-time repository transition

This repository currently asserts, in code and in tests, that the packages are **not** on npm. Those
assertions are correct today and become false the moment 0.1.0 is published, so the bootstrap is not
finished until they are updated.

Do this as a single follow-up commit or pull request, immediately after the manual publish. Until it
lands, the repository is telling readers something untrue.

1. **Root [`README.md`](../README.md)** — change the status callout near the top, which currently
   says the packages are prepared for publication but not published, and remove the warning above
   the install commands that says they will fail with a 404.
2. **[`packages/runtime/README.md`](../packages/runtime/README.md)** and
   **[`packages/testkit/README.md`](../packages/testkit/README.md)** — replace the "Not yet on npm"
   callout in each with the published version.
3. **This document** — record the bootstrap as completed (which version, roughly when), and change
   the note at the top that says neither package has been published. Section A stays as the
   historical record of how the first release happened; it is not repeated for later versions.
4. **[`scripts/validate-metadata.ts`](../scripts/validate-metadata.ts)** — the `claimPatterns` block
   rejects npm version badges and links to npm package pages anywhere in the documentation. That rule
   exists only to prevent claiming a publication that had not happened. Once 0.1.0 is public the rule
   is wrong, and it will block the README edits above. Remove it, or invert it into a check that a
   claimed version actually matches the manifests.
5. **[`tests/packaging.test.ts`](../tests/packaging.test.ts)** — the
   `does not claim the packages are already published` test asserts the pre-publication wording in
   both the README and this document. Update it to assert the post-publication wording, or delete it
   if there is no longer a claim worth pinning. Everything else in that file — metadata, tarball
   contents, workflow guarantees — stays exactly as it is and must keep passing.
6. **Run the full suite** before opening the pull request:

   ```bash
   npm run format:check
   npm run lint
   npm run typecheck
   npm run test:coverage
   npm run build
   npm run package:smoke
   npm run release:check
   npm run metadata:validate
   ```

Nothing else changes. In particular the package manifests, the publish workflow, and the version
stay untouched: this transition is about statements the repository makes, not about what it ships.

---

## B. Future releases through Trusted Publishing

Once both packages exist on npm, publishing moves into GitHub Actions using OIDC. No long-lived npm
write token is created, stored in GitHub secrets, or referenced by the workflow.

### Configure the Trusted Publisher on npmjs.com

This is a manual, npm-side step. **The existence of `.github/workflows/publish.yml` does not
configure anything**; until these settings are saved on npmjs.com, an OIDC publish will fail with
`ENEEDAUTH`.

Do this **once per package** — npm scopes a Trusted Publisher to a single package, so
`@agent-tool-platform/runtime` and `@agent-tool-platform/testkit` each need their own configuration.

For each package: **npmjs.com → Packages → the package → Settings → Trusted publishing**, then:

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

Two more things npm requires and this repository already satisfies:

- publication must run on a GitHub-hosted runner (self-hosted runners are not accepted),
- each package's `repository.url` must match this GitHub repository, which `release:check` asserts.

### Run a release

1. Merge the version change to the default branch. This workflow never bumps a version.
2. Actions → **Publish** → **Run workflow**, from the default branch, with the version to publish.
   Use the `dry_run` option first if you want the full validation and a `npm publish --dry-run`
   without publishing.
3. The workflow refuses to run from any branch other than the default one, runs format, lint,
   typecheck, coverage, build, package smoke, `release:check`, and metadata validation, confirms the
   requested version matches the manifests, confirms neither version already exists on the registry,
   and only then publishes the runtime followed by the testkit.

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
published, testkit not. The workflow detects exactly this and fails with an explicit partial-release
message.

Recover by publishing the testkit **at the same version**:

```bash
npm publish --workspace @agent-tool-platform/testkit --access public
```

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
