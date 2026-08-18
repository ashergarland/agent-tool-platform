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
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/u);
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
      expect(manifest.exports?.['.']).toEqual({
        types: './dist/index.d.ts',
        import: './dist/index.js',
      });
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
    expect(output).toContain(`Release check passed for ${runtime.version}`);
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
  it('is valid YAML with a single manual trigger', () => {
    expect(Object.keys(workflow.on ?? {})).toEqual(['workflow_dispatch']);
  });

  it('requests only the permissions trusted publishing needs', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(publishJob.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
  });

  it('runs on a GitHub-hosted runner, which npm requires for OIDC', () => {
    expect(String(publishJob['runs-on'])).toMatch(/^ubuntu-/u);
  });

  it('carries no npm write credential of any kind', () => {
    expect(workflowSource).not.toContain('NODE_AUTH_TOKEN');
    expect(workflowSource).not.toContain('NPM_TOKEN');
    expect(workflowSource).not.toMatch(/_authToken/u);
    expect(workflowSource).not.toMatch(/secrets\./u);
  });

  it('refuses to publish from a branch other than the default one', () => {
    const guard = steps[0];
    expect(guard?.run).toContain('DEFAULT_BRANCH');
    expect(guard?.run).toContain('exit 1');
    expect(indexOfStep(runsPublish)).toBeGreaterThan(0);
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

  it('refuses to republish an existing version and never forces one', () => {
    const guard = steps.find((step) => (step.run ?? '').includes('assert_absent'));
    expect(guard?.run).toContain('immutable');
    expect(workflowSource).not.toMatch(/npm publish[^\n]*--force/u);
  });

  it('reports a partial release instead of failing silently', () => {
    const report = steps.find((step) => (step.run ?? '').includes('PARTIAL RELEASE'));
    expect(report?.if).toContain('failure()');
    expect(report?.if).toContain("steps.publish-runtime.outcome == 'success'");
    expect(report?.run).toContain('the same version');
    // Recovery is republishing the testkit at the same version, never an independent bump.
    expect(report?.run).toContain('lockstep');
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

  it('does not claim the packages are already published', () => {
    expect(releasing).toMatch(/has been published|has not been published|not been published/u);
    for (const document of [releasing, readme]) {
      expect(document).not.toMatch(/shields\.io\/npm\//u);
    }
    expect(readme).toMatch(/(has|have) not been published|Neither has been published yet/u);
  });

  it('documents the consumer installation for both packages', () => {
    expect(readme).toContain('npm install @agent-tool-platform/runtime');
    expect(readme).toContain('npm install --save-dev @agent-tool-platform/testkit');
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
