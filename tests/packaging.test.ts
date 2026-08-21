import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { load } from 'js-yaml';

/**
 * Distribution invariants.
 *
 * These are the facts that decide whether a published release is coherent, and every one of them
 * fails silently inside this workspace: the monorepo resolves the local runtime no matter what the
 * testkit's dependency range says, and a workflow that publishes at the wrong moment looks perfectly
 * healthy until it runs. So they are asserted here rather than reviewed by eye.
 *
 * Nothing in this file contacts npm. `npm run package:smoke` covers the tarball contents and the
 * external-consumer install; this suite covers manifests, the release workflow, and the claims the
 * documentation makes.
 */

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relativePath: string): string =>
  readFileSync(join(repositoryRoot, relativePath), 'utf8');
const readBytes = (relativePath: string): Buffer =>
  readFileSync(join(repositoryRoot, relativePath));
const rootLicense = readBytes('LICENSE');

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly private?: boolean;
  readonly license?: string;
  readonly homepage?: string;
  readonly keywords?: readonly string[];
  readonly files?: readonly string[];
  readonly exports?: Record<string, unknown>;
  readonly publishConfig?: Record<string, string>;
  readonly repository?: Record<string, string>;
  readonly bugs?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

const readManifest = (relativePath: string): PackageManifest =>
  JSON.parse(read(relativePath)) as PackageManifest;

const runtimeName = '@agent-tool-platform/runtime';
const testkitName = '@agent-tool-platform/testkit';
const developmentVersion = '0.0.0-development';
const gitUrl = 'git+https://github.com/ashergarland/agent-tool-platform.git';

const runtime = readManifest('packages/runtime/package.json');
const testkit = readManifest('packages/testkit/package.json');
const root = readManifest('package.json');

describe('publishable package metadata', () => {
  const publishable: readonly (readonly [string, PackageManifest, string, string])[] = [
    ['runtime', runtime, runtimeName, 'packages/runtime'],
    ['testkit', testkit, testkitName, 'packages/testkit'],
  ];

  it.each(publishable)(
    '%s is a public, truthful npm package',
    (_label, manifest, name, directory) => {
      expect(manifest.name).toBe(name);
      expect(manifest.private).toBeUndefined();
      expect(manifest.version).toBe(developmentVersion);
      expect(manifest.license).toBe('MIT');
      expect(manifest.publishConfig).toEqual({
        access: 'public',
        registry: 'https://registry.npmjs.org',
      });
      expect(manifest.repository).toEqual({ type: 'git', url: gitUrl, directory });
      expect(manifest.homepage).toContain('https://github.com/ashergarland/agent-tool-platform');
      expect(manifest.bugs).toEqual({
        url: 'https://github.com/ashergarland/agent-tool-platform/issues',
      });
      expect(manifest.keywords?.length).toBeGreaterThan(0);
      expect(manifest.files).toContain('dist');
      expect(manifest.files).toContain('README.md');
      expect(manifest.files).toContain('LICENSE');
      expect(manifest.exports?.['.']).toEqual({
        types: './dist/index.d.ts',
        import: './dist/index.js',
      });
    },
  );

  it.each(publishable)(
    '%s carries the repository license verbatim',
    (_label, _manifest, _name, directory) => {
      // Compared as bytes: a re-wrapped or re-worded copy is a different legal document, and
      // `"license": "MIT"` in a manifest is a claim about text the consumer must actually receive.
      expect(readBytes(`${directory}/LICENSE`)).toEqual(rootLicense);
    },
  );

  it('versions the two packages in lockstep with the repository', () => {
    expect(testkit.version).toBe(runtime.version);
    expect(root.version).toBe(runtime.version);
  });

  it('depends on the exact runtime version rather than a range or a local protocol', () => {
    expect(testkit.dependencies?.[runtimeName]).toBe(runtime.version);
  });

  it.each(publishable)('%s declares only registry-resolvable dependencies', (_l, manifest) => {
    for (const range of Object.values(manifest.dependencies ?? {})) {
      expect(range).not.toMatch(/^(workspace:|file:|link:|portal:|git|github:|https?:)/u);
    }
  });

  it('keeps the dependency pointing one way only', () => {
    expect(runtime.dependencies?.[testkitName]).toBeUndefined();
    expect(runtime.devDependencies?.[testkitName]).toBeUndefined();
    expect(testkit.dependencies?.[runtimeName]).toBeDefined();
  });

  it('keeps the repository root and the example fixture unpublishable', () => {
    expect(root.private).toBe(true);
    expect(readManifest('examples/minimal-capability/package.json').private).toBe(true);
  });

  it('passes the release consistency check', () => {
    const output = execFileSync(
      process.execPath,
      [join(repositoryRoot, 'scripts', 'release-check.mjs')],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
    expect(output).toContain(`Development check passed for ${runtime.version}`);
    expect(output).toContain('publishes nothing');
  });
});

interface WorkflowStep {
  readonly name?: string;
  readonly id?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly if?: string;
  readonly with?: Record<string, unknown>;
  readonly env?: Record<string, string>;
}

interface WorkflowJob {
  readonly 'runs-on': string;
  readonly permissions?: Record<string, string>;
  readonly steps: readonly WorkflowStep[];
}

interface Workflow {
  readonly on?: Record<string, unknown>;
  readonly permissions?: Record<string, string>;
  readonly jobs: Record<string, WorkflowJob>;
}

interface WorkflowDispatchTrigger {
  readonly inputs?: Record<string, { readonly default?: boolean }>;
}

const workflowSource = read('.github/workflows/publish.yml');
// js-yaml parsing is the syntax check: an invalid workflow throws here.
const workflow = load(workflowSource) as Workflow;
const publishJob = workflow.jobs.publish as WorkflowJob;
const steps = publishJob.steps;
const indexOfStep = (predicate: (step: WorkflowStep) => boolean): number =>
  steps.findIndex(predicate);
const runsPublish = (step: WorkflowStep): boolean =>
  typeof step.run === 'string' && /npm publish/u.test(step.run) && !/--dry-run/u.test(step.run);

describe('release workflow', () => {
  it('publishes from version tags or deliberate dispatch, never ordinary pushes or pull requests', () => {
    const triggers = workflow.on ?? {};
    expect(Object.keys(triggers)).toEqual(['push', 'workflow_dispatch']);
    expect(triggers.push).toEqual({ tags: ['v*'] });
    expect(triggers).not.toHaveProperty('pull_request');
    expect(triggers).toHaveProperty('workflow_dispatch');
  });

  it('requests only the permissions trusted publishing and GitHub Releases need', () => {
    expect(workflow.permissions).toEqual({ contents: 'write', 'id-token': 'write' });
    expect(publishJob.permissions).toEqual({ contents: 'write', 'id-token': 'write' });
  });

  it('runs on a GitHub-hosted runner, which npm requires for OIDC', () => {
    expect(String(publishJob['runs-on'])).toMatch(/^ubuntu-/u);
  });

  it('uses the Trusted Publishing toolchain without package-manager caching', () => {
    expect(steps.find((step) => step.uses?.startsWith('actions/checkout'))?.uses).toBe(
      'actions/checkout@v7',
    );
    const setupNode = steps.find((step) => step.uses?.startsWith('actions/setup-node'));
    expect(setupNode?.uses).toBe('actions/setup-node@v7');
    expect(setupNode?.with?.['node-version']).toBe(24);
    expect(setupNode?.with?.['registry-url']).toBe('https://registry.npmjs.org');
    expect(setupNode?.with?.['package-manager-cache']).toBe(false);
    expect(setupNode?.with).not.toHaveProperty('cache');
  });

  it('installs a pinned npm rather than whatever is newest that day', () => {
    const step = steps.find((candidate) => (candidate.run ?? '').includes('npm install -g'));
    expect(step, 'the workflow must install a specific npm').toBeDefined();

    // `npm@latest` is already a major ahead of the pin, so an unpinned install would silently
    // change the tool that performs the release.
    expect(step?.run).not.toMatch(/npm@latest|npm@next|npm@\^|npm@~|npm@\*/u);

    const pinned = step?.env?.NPM_VERSION;
    expect(pinned, 'the npm version must be pinned exactly').toMatch(/^\d+\.\d+\.\d+$/u);
    expect(step?.run).toContain('npm install -g "npm@${NPM_VERSION}"');
    // Installing the pin is not enough; the runner must actually be running it.
    expect(step?.run).toContain('"$installed" != "$NPM_VERSION"');

    // The trusted-publishing floor survives the pin, so lowering the pin fails here rather than
    // at the publish step with an authentication error.
    const minimum = step?.env?.NPM_TRUSTED_PUBLISHING_MINIMUM;
    expect(minimum).toBe('11.5.1');
    const asNumbers = (value: string): number[] => value.split('.').map(Number);
    const [pinnedMajor = 0, pinnedMinor = 0, pinnedPatch = 0] = asNumbers(pinned ?? '0.0.0');
    const [minMajor = 0, minMinor = 0, minPatch = 0] = asNumbers(minimum ?? '0.0.0');
    expect(
      pinnedMajor * 1e6 + pinnedMinor * 1e3 + pinnedPatch,
      `pinned npm ${pinned} is below the trusted publishing minimum ${minimum}`,
    ).toBeGreaterThanOrEqual(minMajor * 1e6 + minMinor * 1e3 + minPatch);
  });

  it('carries no npm write credential of any kind', () => {
    expect(workflowSource).not.toContain('NODE_AUTH_TOKEN');
    expect(workflowSource).not.toContain('NPM_TOKEN');
    expect(workflowSource).not.toMatch(/_authToken/u);
    expect(workflowSource).not.toMatch(/secrets\./u);
  });

  it('validates tag ancestry and requires dispatch from the default branch', () => {
    const guard = steps.find((step) => step.id === 'version');
    expect(guard?.run).toContain('git merge-base --is-ancestor');
    expect(guard?.run).toContain('origin/$DEFAULT_BRANCH');
    expect(guard?.run).toContain('"$REF_NAME" != "$DEFAULT_BRANCH"');
    expect(guard?.run).toContain('Release tags must have the shape v<package-version>');
  });

  it('uses the tag as the normal release version and stamps only after npm ci', () => {
    const guard = steps.find((step) => step.id === 'version');
    expect(guard?.run).toContain('requested="${REF_NAME#v}"');
    expect(guard?.run).not.toContain("require('./package.json').version");

    const installAt = indexOfStep((step) => (step.run ?? '').includes('npm ci'));
    const stampAt = indexOfStep((step) =>
      (step.run ?? '').includes('scripts/stamp-release-version.mjs'),
    );
    expect(stampAt).toBeGreaterThan(installAt);
    expect(steps[stampAt]?.run).toContain('"$RELEASE_VERSION"');
    expect(
      indexOfStep((step) => (step.run ?? '').includes('npm run format:check')),
    ).toBeGreaterThan(stampAt);
  });

  it('completes the entire validation suite before anything is published', () => {
    const firstPublish = indexOfStep(runsPublish);
    expect(firstPublish).toBeGreaterThan(0);
    for (const command of [
      'npm ci',
      'npm run format:check',
      'npm run lint',
      'npm run typecheck',
      'npm run test:coverage',
      'npm run build',
      'npm run package:smoke',
      'npm run release:check',
      'npm run metadata:validate',
    ]) {
      const at = indexOfStep((step) => (step.run ?? '').includes(command));
      expect(at, `${command} must run in the publish workflow`).toBeGreaterThanOrEqual(0);
      expect(at, `${command} must run before publishing`).toBeLessThan(firstPublish);
    }
  });

  it('publishes the runtime before the testkit, each targeting its own workspace', () => {
    const runtimeAt = indexOfStep(
      (step) => runsPublish(step) && (step.run ?? '').includes(runtimeName),
    );
    const testkitAt = indexOfStep(
      (step) => runsPublish(step) && (step.run ?? '').includes(testkitName),
    );
    expect(runtimeAt).toBeGreaterThanOrEqual(0);
    expect(testkitAt).toBeGreaterThan(runtimeAt);
    expect(steps[runtimeAt]?.run).toContain('--workspace @agent-tool-platform/runtime');
    expect(steps[testkitAt]?.run).toContain('--workspace @agent-tool-platform/testkit');
  });

  it('handles absent, complete, partial, and inverted registry states explicitly', () => {
    const guard = steps.find((step) => step.id === 'registry');
    expect(guard?.run).toContain('mode="normal"');
    expect(guard?.run).toContain('already released; npm versions are immutable');
    expect(guard?.run).toContain('mode="recover-testkit"');
    expect(guard?.run).toContain('Partial release detected');
    expect(guard?.run).toContain('Broken release state');
    expect(guard?.run).toContain('RECOVER_TESTKIT_ONLY');
    expect(workflowSource).not.toMatch(/npm publish[^\n]*--force/u);
  });

  it('waits for registry propagation and verifies the published dependency', () => {
    const runtimeWait = indexOfStep((step) =>
      (step.run ?? '').includes('runtime@$VERSION registry propagation'),
    );
    const testkitPublish = indexOfStep(
      (step) => runsPublish(step) && (step.run ?? '').includes(testkitName),
    );
    const testkitVerify = indexOfStep((step) => (step.run ?? '').includes('runtime_dependency'));
    expect(runtimeWait).toBeGreaterThan(
      indexOfStep((step) => runsPublish(step) && (step.run ?? '').includes(runtimeName)),
    );
    expect(testkitPublish).toBeGreaterThan(runtimeWait);
    expect(testkitVerify).toBeGreaterThan(testkitPublish);
    expect(steps[runtimeWait]?.run).toContain('seq 1 18');
    expect(steps[testkitVerify]?.run).toContain("['@agent-tool-platform/runtime']");
  });

  it('reports partial releases with the deliberate recovery path', () => {
    const report = steps.find((step) => (step.run ?? '').includes('PARTIAL RELEASE'));
    const fallbackReport =
      report ?? steps.find((step) => (step.run ?? '').includes('recover_testkit_only'));
    expect(fallbackReport?.if).toContain('failure()');
    expect(fallbackReport?.run).toContain('workflow_dispatch');
    expect(fallbackReport?.run).toContain('recover_testkit_only');
    expect(fallbackReport?.run).toContain('Do not republish');
  });

  it('limits manual dispatch to dry runs or explicit testkit recovery', () => {
    const dispatch = (workflow.on?.workflow_dispatch as WorkflowDispatchTrigger)?.inputs;
    expect(dispatch?.dry_run?.default).toBe(true);
    expect(dispatch?.recover_testkit_only?.default).toBe(false);
    const guard = steps.find((step) => step.id === 'version');
    expect(guard?.run).toContain('workflow_dispatch may only perform a dry run');
    expect(guard?.run).toContain('git checkout --detach "$release_commit"');
  });

  it('creates generated-notes GitHub Releases only after public npm verification', () => {
    const verifyAt = indexOfStep((step) => (step.run ?? '').includes('runtime_dependency'));
    const releaseAt = indexOfStep((step) => (step.run ?? '').includes('gh release create'));
    expect(releaseAt).toBeGreaterThan(verifyAt);
    expect(steps[releaseAt]?.run).toContain('--generate-notes');
    expect(steps[releaseAt]?.run).toContain('gh release view');
    expect(steps[releaseAt]?.if).toContain("github.event_name != 'workflow_dispatch'");
  });
});

describe('continuous integration', () => {
  const ci = read('.github/workflows/ci.yml');

  it('validates the release layout on every pull request without publishing', () => {
    expect(ci).toContain('npm run release:check');
    expect(ci).toContain('npm run package:smoke');
    expect(ci).not.toMatch(/npm publish/u);
  });

  it('permits publish commands in the release workflow only', () => {
    for (const file of ['ci.yml', 'security.yml']) {
      expect(read(`.github/workflows/${file}`), file).not.toMatch(/npm publish/u);
    }
    expect(workflowSource).toMatch(/npm publish/u);
  });
});

describe('release documentation', () => {
  const releasing = read('docs/releasing.md');
  const readme = read('README.md');

  it('makes the two-command tag release path authoritative', () => {
    for (const document of [readme, releasing]) {
      expect(document).toContain('git tag vX.Y.Z');
      expect(document).toContain('git push origin vX.Y.Z');
      expect(document).toContain("That's it");
    }
    expect(releasing).toContain('0.0.0-development');
    expect(releasing).toMatch(/No `package\.json` edits\. No lockfile edits/iu);
    expect(releasing).toContain('generated notes');
  });

  it('documents the one-time manual bootstrap in the only safe order', () => {
    const runtimeAt = releasing.indexOf(
      'npm publish --workspace @agent-tool-platform/runtime --access public',
    );
    const testkitAt = releasing.indexOf(
      'npm publish --workspace @agent-tool-platform/testkit --access public',
    );
    expect(runtimeAt).toBeGreaterThan(0);
    expect(testkitAt).toBeGreaterThan(runtimeAt);
    expect(releasing).toContain('npm whoami');
    expect(releasing).toMatch(/Do not publish the testkit first/iu);
  });

  it('describes publishing the testkit first as temporary breakage, not a lost version', () => {
    // Publishing out of order leaves the testkit unresolvable only until the runtime version it
    // depends on is published; it does not permanently burn the version. Overstating that would
    // push a maintainer into an unnecessary bump, which is exactly what the lockstep rule forbids.
    expect(releasing).toMatch(/temporarily uninstallable/iu);
    expect(releasing).toMatch(/until .*runtime@0\.1\.0.*is itself published/su);
    expect(releasing).not.toMatch(/the only fix is another version/iu);
  });

  it('records the completed bootstrap while preserving it as one-time history', () => {
    expect(releasing).toContain('August 2026');
    expect(releasing).toMatch(/Bootstrap complete/iu);
    expect(releasing).toMatch(/historical documentation/iu);
    expect(releasing).toMatch(/must not be repeated/iu);
    expect(releasing).toContain('Completed repository transition');
  });

  it('documents the npm-side Trusted Publisher configuration', () => {
    for (const value of [
      'GitHub Actions',
      'ashergarland',
      'agent-tool-platform',
      'publish.yml',
      'npm publish',
      'once per package',
    ]) {
      expect(releasing).toContain(value);
    }
    expect(releasing).toMatch(/two-factor authentication and disallow tokens/iu);
  });

  it('states that 0.1.0 is public and contains no stale unpublished claim', () => {
    const documents = [
      releasing,
      readme,
      read('packages/runtime/README.md'),
      read('packages/testkit/README.md'),
    ];
    expect(releasing).toMatch(/0\.1\.0 were published in August 2026/iu);
    expect(readme).toMatch(/0\.1\.0 are publicly available from npm/iu);
    for (const document of documents) {
      expect(document).not.toMatch(
        /packages? (?:has|have) not been published|not (?:yet )?published on npm/iu,
      );
    }
    expect(read('scripts/validate-metadata.ts')).not.toContain('PRE-PUBLICATION ONLY');
  });

  it('documents the consumer installation for both packages', () => {
    expect(readme).toContain('npm install @agent-tool-platform/runtime');
    expect(readme).toContain('npm install -D @agent-tool-platform/testkit');
    expect(readme).toContain('lockstep');
  });

  it('embeds no credential', () => {
    // The document names these variables to say they are deliberately unused; what must not appear
    // is a value assigned to one, or anything shaped like a real npm token.
    expect(releasing).not.toMatch(/npm_[A-Za-z0-9]{20,}/u);
    expect(releasing).not.toMatch(/(NPM_TOKEN|NODE_AUTH_TOKEN)\s*[:=]\s*[^\s`]+/u);
    expect(releasing).not.toMatch(/_authToken\s*=/u);
    expect(releasing).not.toMatch(/secrets\.NPM/u);
    expect(releasing).toMatch(/no long-lived npm\s+write token/iu);
  });
});
