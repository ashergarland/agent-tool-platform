import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

interface WorkflowInput {
  readonly type?: string;
  readonly default?: string | boolean;
}

interface WorkflowStep {
  readonly name?: string;
  readonly id?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly if?: string;
  readonly with?: Record<string, unknown>;
  readonly env?: Record<string, string>;
  readonly 'continue-on-error'?: boolean;
}

interface WorkflowJob {
  readonly 'runs-on': string;
  readonly permissions?: Record<string, string>;
  readonly steps: readonly WorkflowStep[];
}

interface Workflow {
  readonly on?: {
    readonly workflow_call?: {
      readonly inputs?: Record<string, WorkflowInput>;
      readonly secrets?: Record<string, unknown>;
    } | null;
  };
  readonly permissions?: Record<string, string>;
  readonly jobs: Record<string, WorkflowJob>;
}

const readWorkflow = (name: string): { readonly source: string; readonly workflow: Workflow } => {
  const source = readFileSync(join(repositoryRoot, '.github', 'workflows', name), 'utf8');
  return { source, workflow: load(source) as Workflow };
};

const findRunStep = (steps: readonly WorkflowStep[], command: string): WorkflowStep | undefined =>
  steps.find((step) => step.run?.includes(command));

const indexOfRunStep = (steps: readonly WorkflowStep[], command: string): number =>
  steps.findIndex((step) => step.run?.includes(command));

describe('reusable capability CI workflow', () => {
  const { source, workflow } = readWorkflow('capability-ci.yml');
  const job = workflow.jobs.capability;
  const steps = job?.steps ?? [];
  const inputs = workflow.on?.workflow_call?.inputs;

  it('exposes only workflow_call with the deliberately small input contract', () => {
    expect(Object.keys(workflow.on ?? {})).toEqual(['workflow_call']);
    expect(inputs).toEqual({
      node_version: expect.objectContaining({ type: 'string', default: '22' }),
      openapi_path: expect.objectContaining({ type: 'string', default: 'openapi.json' }),
      run_package_smoke: expect.objectContaining({ type: 'boolean', default: false }),
    });
  });

  it('checks out the caller on a GitHub-hosted runner with current action majors', () => {
    expect(job?.['runs-on']).toMatch(/^ubuntu-/u);
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout'));
    expect(checkout?.uses).toBe('actions/checkout@v7');
    expect(checkout?.with?.repository).toBeUndefined();
    const setupNode = steps.find((step) => step.uses?.startsWith('actions/setup-node'));
    expect(setupNode?.uses).toBe('actions/setup-node@v7');
    expect(setupNode?.with?.['node-version']).toBe('${{ inputs.node_version }}');
    expect(inputs?.node_version?.default).toBe('22');
  });

  it('runs the complete standard capability contract without publishing', () => {
    for (const command of [
      'npm ci',
      'npm run format:check',
      'npm run lint',
      'npm run typecheck',
      'npm run test:coverage',
      'npm run build',
      'npm run openapi:emit',
      'npm run metadata:validate',
    ]) {
      expect(findRunStep(steps, command), command).toBeDefined();
    }
    expect(source).not.toMatch(/npm publish/u);
  });

  it('requires package smoke when requested rather than accepting a missing script', () => {
    const smoke = findRunStep(steps, 'npm run package:smoke');
    expect(smoke?.if).toContain('inputs.run_package_smoke');
    expect(smoke?.run).not.toContain('--if-present');
  });

  it('uploads generic OpenAPI and optional coverage artifacts with upload-artifact v7', () => {
    const uploads = steps.filter((step) => step.uses?.startsWith('actions/upload-artifact'));
    expect(uploads).toHaveLength(2);
    expect(uploads.every((step) => step.uses === 'actions/upload-artifact@v7')).toBe(true);
    expect(uploads.find((step) => step.with?.name === 'capability-openapi')?.with).toEqual(
      expect.objectContaining({
        path: '${{ inputs.openapi_path }}',
        'if-no-files-found': 'error',
      }),
    );
    expect(uploads.find((step) => step.with?.name === 'capability-coverage')?.with).toEqual(
      expect.objectContaining({
        path: 'coverage/lcov.info',
        'if-no-files-found': 'ignore',
      }),
    );
  });
});

describe('reusable capability security workflow', () => {
  const { source, workflow } = readWorkflow('capability-security.yml');
  const dependencyAudit = workflow.jobs['dependency-audit'];
  const secretScan = workflow.jobs.secrets;
  const codeql = workflow.jobs.codeql;

  it('exposes only workflow_call and defines the three common security jobs', () => {
    expect(Object.keys(workflow.on ?? {})).toEqual(['workflow_call']);
    expect(Object.keys(workflow.jobs)).toEqual(['dependency-audit', 'secrets', 'codeql']);
  });

  it('blocks on high runtime advisories and reports development critical advisories', () => {
    const runtimeAudit = findRunStep(
      dependencyAudit?.steps ?? [],
      'npm audit --omit=dev --audit-level=high',
    );
    const developmentAudit = findRunStep(
      dependencyAudit?.steps ?? [],
      'npm audit --audit-level=critical',
    );
    expect(runtimeAudit).toBeDefined();
    expect(runtimeAudit?.['continue-on-error']).not.toBe(true);
    expect(developmentAudit?.['continue-on-error']).toBe(true);
  });

  it('checks full history with gitleaks and only the normal GitHub token', () => {
    const checkout = secretScan?.steps.find((step) => step.uses?.startsWith('actions/checkout'));
    const gitleaks = secretScan?.steps.find((step) =>
      step.uses?.startsWith('gitleaks/gitleaks-action'),
    );
    expect(checkout?.uses).toBe('actions/checkout@v7');
    expect(checkout?.with?.['fetch-depth']).toBe(0);
    expect(gitleaks?.uses).toBe('gitleaks/gitleaks-action@v2');
    expect(gitleaks?.env).toEqual({ GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}' });
    expect(workflow.on?.workflow_call?.secrets).toBeUndefined();
    expect(source).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|secrets:\s+inherit/u);
  });

  it('runs CodeQL v4 for JavaScript and TypeScript without a caller-specific config', () => {
    const init = codeql?.steps.find((step) => step.uses?.includes('codeql-action/init'));
    const analyze = codeql?.steps.find((step) => step.uses?.includes('codeql-action/analyze'));
    expect(init?.uses).toBe('github/codeql-action/init@v4');
    expect(init?.with?.languages).toBe('javascript-typescript');
    expect(init?.with).not.toHaveProperty('config-file');
    expect(analyze?.uses).toBe('github/codeql-action/analyze@v4');
    expect(codeql?.permissions).toEqual({
      contents: 'read',
      'security-events': 'write',
      packages: 'read',
    });
  });
});

describe('reusable single-package capability release workflow', () => {
  const { source, workflow } = readWorkflow('capability-release.yml');
  const job = workflow.jobs.release;
  const steps = job?.steps ?? [];
  const inputs = workflow.on?.workflow_call?.inputs;
  const publishAt = steps.findIndex((step) => step.id === 'publish');
  const publishStep = steps[publishAt];

  it('exposes workflow_call with safe dry-run and release-only recovery inputs', () => {
    expect(Object.keys(workflow.on ?? {})).toEqual(['workflow_call']);
    expect(inputs).toEqual({
      version: expect.objectContaining({ type: 'string', default: '' }),
      dry_run: expect.objectContaining({ type: 'boolean', default: false }),
      recover_github_release: expect.objectContaining({ type: 'boolean', default: false }),
    });
  });

  it('uses the GitHub-hosted Trusted Publishing toolchain and exact permissions', () => {
    expect(job?.['runs-on']).toMatch(/^ubuntu-/u);
    expect(workflow.permissions).toEqual({ contents: 'write', 'id-token': 'write' });
    expect(job?.permissions).toEqual({ contents: 'write', 'id-token': 'write' });

    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout'));
    const setupNode = steps.find((step) => step.uses?.startsWith('actions/setup-node'));
    expect(checkout?.uses).toBe('actions/checkout@v7');
    expect(checkout?.with?.['fetch-depth']).toBe(0);
    expect(checkout?.with).not.toHaveProperty('repository');
    expect(setupNode?.uses).toBe('actions/setup-node@v7');
    expect(setupNode?.with).toEqual({
      'node-version': 24,
      'registry-url': 'https://registry.npmjs.org',
      'package-manager-cache': false,
    });
  });

  it('pins npm above the Trusted Publishing minimum without any npm credential', () => {
    const npmInstall = findRunStep(steps, 'npm install -g "npm@${NPM_VERSION}"');
    expect(npmInstall?.env?.NPM_VERSION).toBe('11.19.0');
    expect(npmInstall?.env?.NPM_TRUSTED_PUBLISHING_MINIMUM).toBe('11.5.1');
    expect(npmInstall?.run).toContain('"$installed" != "$NPM_VERSION"');
    expect(source).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|_authToken|secrets\./u);
  });

  it('contains syntactically valid embedded Node validators', () => {
    const nodeBlocks = steps.flatMap((step) =>
      [...(step.run ?? '').matchAll(/<<'NODE'\n([\s\S]*?)\nNODE/gu)].map((match) => match[1] ?? ''),
    );
    expect(nodeBlocks.length).toBeGreaterThanOrEqual(5);
    for (const script of nodeBlocks) {
      const result = spawnSync(process.execPath, ['--check', '-'], {
        input: script,
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
    }
  });

  it('makes pushed tags authoritative and checks default-branch ancestry', () => {
    const version = steps.find((step) => step.id === 'version');
    expect(version?.run).toContain('requested="${REF_NAME#v}"');
    expect(version?.run).toContain('Normal releases require a pushed stable-semver tag');
    expect(version?.run).toContain(
      "version_pattern='^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'",
    );
    expect(version?.run).toContain('git merge-base --is-ancestor');
    expect(version?.run).toContain('origin/$DEFAULT_BRANCH');
    expect(version?.run).not.toContain("require('./package.json').version");
  });

  it('allows manual execution only for dry-run validation or explicit recovery', () => {
    const version = steps.find((step) => step.id === 'version');
    expect(version?.run).toContain('workflow_dispatch cannot perform an ordinary release');
    expect(version?.run).toContain('RECOVER_GITHUB_RELEASE');
    expect(version?.run).toContain('git checkout --detach "$release_commit"');
    expect(publishStep?.if).toContain("steps.version.outputs.mode == 'normal'");
  });

  it('requires one root package in development state and stamps only on the runner', () => {
    const development = findRunStep(steps, "readFileSync('package.json'");
    const stamp = findRunStep(
      steps,
      'npm version "$RELEASE_VERSION" --no-git-tag-version --ignore-scripts',
    );
    const metadataStamp = findRunStep(steps, 'manifest.gitHead = process.env.EXPECTED_COMMIT');
    expect(development?.run).toContain("const developmentVersion = '0.0.0-development'");
    expect(development?.run).toContain('manifest.workspaces !== undefined');
    expect(development?.run).toContain("lock.packages?.['']");
    expect(development?.run).toContain('manifest.private === true');
    expect(development?.run).toContain('EXPECTED_REPOSITORY');
    expect(development?.run).toContain("readFileSync('server.json'");
    expect(development?.run).toContain('npmPackages.length !== 1');
    expect(development?.run).toContain('manifest.publishConfig?.registry');
    expect(stamp).toBeDefined();
    expect(metadataStamp?.run).toContain('server.version = process.env.RELEASE_VERSION');
    expect(indexOfRunStep(steps, 'npm ci')).toBeLessThan(steps.indexOf(stamp as WorkflowStep));
    expect(source).not.toMatch(/git (commit|push)/u);
  });

  it('runs every publication quality gate and mandatory package smoke before publishing', () => {
    expect(publishAt).toBeGreaterThan(0);
    for (const command of [
      'npm ci',
      'npm run format:check',
      'npm run lint',
      'npm run typecheck',
      'npm run test:coverage',
      'npm run build',
      'npm run openapi:emit',
      'npm run metadata:validate',
      'npm run package:smoke',
      'npm pack --ignore-scripts --json',
    ]) {
      const commandAt = indexOfRunStep(steps, command);
      expect(commandAt, command).toBeGreaterThanOrEqual(0);
      expect(commandAt, `${command} must run before publication`).toBeLessThan(publishAt);
    }
    expect(findRunStep(steps, 'npm run package:smoke')?.run).not.toContain('--if-present');
  });

  it('fails closed on registry ambiguity and never overwrites an existing npm version', () => {
    const registry = steps.find((step) => step.id === 'registry');
    expect(registry?.run).toContain('npm view "$PACKAGE_NAME@$VERSION"');
    expect(registry?.run).toContain('E404');
    expect(registry?.run).toContain('Could not determine registry state');
    expect(registry?.run).toContain('npm versions are immutable');
    expect(registry?.run).toContain('--registry="$REGISTRY_URL"');
    expect(registry?.run).toContain('--${package_scope}:registry=$REGISTRY_URL');
    expect(source).not.toMatch(/npm publish[^\n]*--force/u);
  });

  it('publishes one validated tarball publicly before npm verification and generated notes', () => {
    const verifyAt = indexOfRunStep(steps, 'registry propagation');
    const releaseAt = indexOfRunStep(steps, 'gh release create');
    expect(publishAt).toBeGreaterThanOrEqual(0);
    expect(publishStep?.run).toContain('npm publish --access public --ignore-scripts');
    expect(publishStep?.run).toContain('"$TARBALL"');
    expect(publishStep?.env?.TARBALL).toBe('${{ steps.tarball.outputs.path }}');
    expect(verifyAt).toBeGreaterThan(publishAt);
    expect(releaseAt).toBeGreaterThan(verifyAt);
    expect(steps[releaseAt]?.run).toContain('--verify-tag --generate-notes');
  });

  it('limits recovery to registry-proven GitHub Release state', () => {
    const registry = steps.find((step) => step.id === 'registry');
    const release = findRunStep(steps, 'gh release create');
    const install = findRunStep(steps, 'npm ci');
    const stamp = findRunStep(steps, 'npm version "$RELEASE_VERSION"');
    expect(registry?.run).toContain('metadata.gitHead');
    expect(registry?.run).toContain('metadata.repository');
    expect(registry?.run).toContain('integrity');
    expect(registry?.run).toContain('recover-github-release');
    expect(install?.if).toContain("mode != 'recover-github-release'");
    expect(stamp?.if).toContain("mode != 'recover-github-release'");
    expect(release?.if).toContain("steps.version.outputs.mode != 'dry-run'");
    expect(publishStep?.if).not.toContain('recover-github-release');
  });

  it('contains no AST-specific package name or path', () => {
    expect(source).not.toMatch(/ast-summarizer|AST_WORKSPACE_ROOT|get_file_skeleton/iu);
    expect(source).not.toContain('@agent-tool-platform/');
  });
});

describe('platform workflow action runtimes', () => {
  it.each(['ci.yml', 'security.yml'])('%s uses current checkout/setup-node majors', (name) => {
    const source = readWorkflow(name).source;
    expect(source).not.toMatch(/actions\/(checkout|setup-node|upload-artifact)@v4/u);
    expect(source).toContain('actions/checkout@v7');
    if (source.includes('actions/setup-node')) expect(source).toContain('actions/setup-node@v7');
  });

  it('keeps platform CI artifacts on upload-artifact v7', () => {
    const source = readWorkflow('ci.yml').source;
    expect(source).toContain('actions/upload-artifact@v7');
  });
});
