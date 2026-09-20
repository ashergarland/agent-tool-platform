# Releasing

The Platform uses one tag-authoritative version for four public packages:

- `@agent-tool-platform/runtime`
- `@agent-tool-platform/capability-registry`
- `@agent-tool-platform/agent-kit`
- `@agent-tool-platform/testkit`

For v0 they are lockstep-versioned. Testkit depends exactly on Runtime at the release version. Agent
Kit depends exactly on Runtime and Capability Registry at the release version. Checked-in manifests
stay at `0.0.0-development`; Capability Registry and Agent Kit also keep `private: true` until the
release stamper removes those two guards in an ephemeral candidate.

Runtime and Testkit 0.1.3 are currently public. Capability Registry and Agent Kit are not yet public,
so the normal four-package path in section A becomes authoritative only after the explicit bootstrap
in section C is completed.

## A. Normal four-package release after bootstrap

Make sure the intended commit is on `main`, then:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

That's it.

The pushed tag is the version authority. The Publish workflow:

1. validates semantic-version tag syntax and proves the tagged commit belongs to default-branch
   history;
2. installs pinned npm 11.19.0 on a GitHub-hosted runner;
3. runs `npm ci`;
4. stamps the root, all four package manifests, the Registry data version, the private example, and
   exact internal dependencies without changing `package-lock.json`;
5. runs format, lint, typecheck, coverage, the full workspace build, package smoke, release
   consistency, and metadata validation;
6. proves the npm version is absent or a source-identical valid prefix;
7. publishes and waits for registry propagation in this fixed order:
   1. Runtime;
   2. Capability Registry;
   3. Agent Kit;
   4. Testkit;
8. verifies all four public versions, repository directories, `gitHead`, integrity digests, and exact
   internal dependencies; and
9. creates the generated-notes GitHub Release only after npm verification succeeds.

Runtime and Capability Registry are independent roots. Agent Kit follows both of its dependencies.
Testkit follows Runtime. Agent Kit precedes Testkit only to make partial states a single fixed prefix;
there is no dependency between the two leaf packages.

No `package.json` edits. No lockfile edits. No release commit. No manual npm publish. No changelog or
release-note file.

### Trusted Publisher contract

Each package has its own npm Trusted Publisher entry with these exact, case-sensitive values:

| Field                    | Value                 |
| ------------------------ | --------------------- |
| Provider                 | GitHub Actions        |
| GitHub organization/user | `ashergarland`        |
| Repository               | `agent-tool-platform` |
| Workflow filename        | `publish.yml`         |
| Environment              | (leave empty)         |
| Allowed action           | `npm publish`         |

The workflow has `id-token: write`, runs on a GitHub-hosted runner, and uses an npm version above the
11.5.1 Trusted Publishing floor. It carries no `NODE_AUTH_TOKEN`, `NPM_TOKEN`, npm secret, or other
long-lived npm write credential. OIDC publications receive npm provenance attestations
automatically. Renaming `publish.yml` breaks the npm-side identity until every package configuration
is updated.

After OIDC publishing is proven, each package should use npm's **Require two-factor authentication
and disallow tokens** publishing setting. Trusted Publishing continues to work because OIDC is not
long-lived token authentication.

### Dry run

Run **Publish** with `workflow_dispatch` from the default branch:

- `version`: the exact candidate version, without `v`;
- `dry_run`: enabled;
- `recover`: disabled.

The workflow stamps all four candidates, runs every quality and package-consumer check, classifies
registry state without changing it, and runs `npm publish --dry-run` for all four workspaces. It
does not publish, create a tag, or create a GitHub Release.

### Partial release and recovery

npm versions are immutable. The workflow never uses `--force` and never uploads an existing
version. Every run queries the four exact package versions and accepts only a prefix of the fixed
order:

1. none;
2. Runtime;
3. Runtime + Capability Registry;
4. Runtime + Capability Registry + Agent Kit;
5. all four.

For every existing package, recovery requires the requested version, this repository and package
directory, the tagged commit as `gitHead`, an integrity digest exactly matching a fresh
`npm pack --dry-run` of the tagged candidate, and the expected exact internal dependencies. An
out-of-order package, wrong source commit, wrong repository, mismatched artefact, or dependency
mismatch fails closed.

To resume a valid partial release, run **Publish** with `workflow_dispatch` from the default branch:

- `version`: the original tag version;
- `dry_run`: disabled;
- `recover`: enabled.

Recovery fetches and detaches at the original `vX.Y.Z` tag, repeats every validation, re-proves the
published prefix, publishes only the missing suffix, verifies the complete release, and creates the
GitHub Release if it is absent. A complete source-identical npm release is also accepted in recovery
mode so a failed final verification or missing GitHub Release can be repaired without republishing.

If the registry state is inconsistent, do not improvise and do not independently bump a package.
Deprecate a genuinely broken version where appropriate and release a new lockstep version.

## B. Historical Runtime/Testkit bootstrap

> **Bootstrap complete.** Runtime and Testkit 0.1.0 were published in August 2026. This section is
> historical documentation and must not be repeated.

npm could not attach a Trusted Publisher before each package existed. A maintainer therefore used
`npm login` and confirmed the local identity with `npm whoami`, validated a clean 0.1.0 candidate,
and published Runtime before Testkit:

```bash
npm publish --workspace @agent-tool-platform/runtime --access public
npm view @agent-tool-platform/runtime@0.1.0 version
npm publish --workspace @agent-tool-platform/testkit --access public
npm view @agent-tool-platform/testkit@0.1.0 dependencies
```

Do not publish the testkit first. Its exact `@agent-tool-platform/runtime: 0.1.0` dependency would
make it temporarily uninstallable until `@agent-tool-platform/runtime@0.1.0` is itself published.
That order mistake is recoverable once Runtime appears, but it creates a needless broken window.

After publication, the npm Trusted Publisher identity above was configured once per package.
Subsequent Runtime/Testkit releases, including the current known 0.1.3 release, used tag-authorized
OIDC. The completed repository transition removed pre-publication-only assertions while retaining
`0.0.0-development` as checked-in metadata.

## C. Pending Capability Registry / Agent Kit bootstrap

> **Not completed. Do not infer npm availability from this plan.** These are one-time operator
> instructions for the first four-package Platform release.

### Recommended first public version

Use **0.2.0**, the next Platform minor after the known 0.1.3 release. Adding two supported public
packages is a material v0 API expansion. Do not backfill them as 0.1.3: Runtime/Testkit 0.1.3 came
from a different source commit and npm versions cannot be overwritten. All four 0.2.0 artefacts must
come from the same `v0.2.0` commit.

### Preconditions

1. Merge the reviewed publication-readiness change to `main`.
2. Confirm all four 0.2.0 versions are absent with `npm view <name>@0.2.0 version`.
3. Confirm the `main` worktree is clean and record `git rev-parse HEAD`.
4. Create and push `v0.2.0`.

The first tagged run is expected to publish Runtime 0.2.0 through its existing Trusted Publisher,
wait until it is resolvable, and then stop at Capability Registry because that package cannot have
an npm Trusted Publisher until it exists. The failure summary must report a partial release. Do not
rerun the tag job and do not publish Testkit independently.

### One-time maintainer publication

Use a disposable clean checkout detached at the exact public tag:

```bash
git fetch origin refs/tags/v0.2.0
git checkout --detach v0.2.0
npm ci
node scripts/stamp-release-version.mjs 0.2.0
export RELEASE_VERSION=0.2.0
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run package:smoke
npm run release:check -- 0.2.0
npm run metadata:validate
npm whoami
```

First prove Runtime is public and belongs to the tag:

```bash
npm view @agent-tool-platform/runtime@0.2.0 version gitHead repository dist.integrity --json
```

Then perform the only two packages that require maintainer-authenticated first publication:

```bash
npm publish --workspace @agent-tool-platform/capability-registry --access public
npm view @agent-tool-platform/capability-registry@0.2.0 version gitHead repository dist.integrity --json

npm publish --workspace @agent-tool-platform/agent-kit --access public
npm view @agent-tool-platform/agent-kit@0.2.0 version gitHead repository dependencies dist.integrity --json
```

Capability Registry has no Platform dependency. Agent Kit is published only after Runtime and
Capability Registry 0.2.0 are publicly resolvable; its npm metadata must show exact dependencies on
both. This prevents Agent Kit from ever referring to a Platform version that does not exist.

For each manual package, retain the `npm pack --json` result from the validated checkout and compare
its integrity value with `npm view <name>@0.2.0 dist.integrity`. The npm `gitHead` must equal the
`v0.2.0` commit, and `repository` must identify this repository and the correct package directory.
Maintainer-authenticated bootstrap publications do not carry GitHub OIDC provenance; this
git-head/integrity comparison is their source-identity proof.

Never put the maintainer credential in this repository, GitHub Actions, or a project `.npmrc`.
`npm login` stores the temporary authenticated session in the operator's user-level configuration.

### Add the two Trusted Publishers

As soon as each new package exists, configure its npm Trusted Publisher:

- `@agent-tool-platform/capability-registry`: GitHub Actions / `ashergarland` /
  `agent-tool-platform` / `publish.yml` / no environment / `npm publish`;
- `@agent-tool-platform/agent-kit`: the same identity.

Do not remove or alter the existing Runtime and Testkit publisher entries.

### Complete 0.2.0 through the normal workflow

Run **Publish** from the default branch with:

- `version`: `0.2.0`;
- `dry_run`: disabled;
- `recover`: enabled.

The state machine must recognize Runtime + Capability Registry + Agent Kit as the valid published
prefix, verify all three against `v0.2.0`, publish only Testkit through its existing OIDC publisher,
verify all four packages, and create the GitHub Release. From that point forward, `publish.yml` is
authoritative for all four packages and section A is the only normal release procedure.

### Bootstrap failure recovery

- If Runtime was not published, fix the validation/authentication cause and rerun the original tag
  job; all four versions must still be absent.
- If Runtime exists but Capability Registry does not, retry only the manual Registry publication
  from the validated tagged checkout.
- If Registry exists but Agent Kit does not, re-verify Runtime and Registry, then retry only Agent
  Kit.
- If the recovery run fails before Testkit exists, rerun the same generic recovery. It revalidates
  the three-package prefix and publishes only Testkit.
- If all four packages exist but final verification or GitHub Release creation failed, rerun the
  same recovery; it verifies without republishing.
- If any existing package has the wrong `gitHead`, repository directory, integrity metadata, or
  exact internal dependency, stop. Never overwrite it. Deprecate the bad version as appropriate and
  prepare a new lockstep Platform version from a new tag.

## Future M5.5 consumer contract

After bootstrap, `ashergarland/agent-composition-template` must consume an exact released Platform
version:

```json
{
  "dependencies": {
    "@agent-tool-platform/agent-kit": "X.Y.Z",
    "@agent-tool-platform/capability-registry": "X.Y.Z"
  }
}
```

It must not use `file:` paths, copied Platform source, workspace links, or a sibling checkout.

## Version policy for v0

- All four Platform packages share one version number.
- Internal Platform dependencies are exact, never ranges.
- Checked-in manifests and lockfile workspace metadata stay at `0.0.0-development`.
- Capability Registry and Agent Kit stay private in checked-in manifests; stamping removes those
  guards only in a release candidate.
- The pushed tag is the release version. Generated changes are never committed or pushed.
- npm versions are immutable.
- There is no Changesets, Lerna, semantic-release, release-please, or independent-version
  machinery.
