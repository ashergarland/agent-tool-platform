import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_CAPABILITY_DECLARATION_PATH,
  runDeploymentValidationCli,
  type DeploymentValidationCliIo,
} from '@agent-tool-platform/runtime';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtureDirectory = join('tests', 'fixtures', 'deployment');

const captureIo = (): {
  readonly io: DeploymentValidationCliIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
} => {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      cwd: repositoryRoot,
      stdout: {
        write: (value) => {
          stdout += value;
        },
      },
      stderr: {
        write: (value) => {
          stderr += value;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
};

describe('agent-tool-validate-deployment CLI', () => {
  it('validates a public declaration alone', async () => {
    const capture = captureIo();
    const exitCode = await runDeploymentValidationCli(
      ['--declaration', join(fixtureDirectory, CANONICAL_CAPABILITY_DECLARATION_PATH)],
      capture.io,
    );

    expect(exitCode).toBe(0);
    expect(capture.stdout()).toBe('Capability profile declaration is valid.\n');
    expect(capture.stderr()).toBe('');
  });

  it('cross-validates a declaration and instance', async () => {
    const capture = captureIo();
    const exitCode = await runDeploymentValidationCli(
      [
        '--declaration',
        join(fixtureDirectory, CANONICAL_CAPABILITY_DECLARATION_PATH),
        '--instance',
        join(fixtureDirectory, 'hosted-provider.deployment.json'),
      ],
      capture.io,
    );

    expect(exitCode).toBe(0);
    expect(capture.stdout()).toBe(
      'Capability profile declaration and deployment instance are valid.\n',
    );
    expect(capture.stderr()).toBe('');
  });

  it('returns a non-zero status with deterministic validation errors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atp-deployment-cli-'));
    try {
      const instance = JSON.parse(
        readFileSync(
          join(repositoryRoot, fixtureDirectory, 'local-package.deployment.json'),
          'utf8',
        ),
      ) as { profile: { id: string } };
      instance.profile.id = 'not-declared';
      const instancePath = join(root, 'invalid-instance.json');
      writeFileSync(instancePath, `${JSON.stringify(instance)}\n`);

      const capture = captureIo();
      const exitCode = await runDeploymentValidationCli(
        [
          '--declaration',
          join(fixtureDirectory, CANONICAL_CAPABILITY_DECLARATION_PATH),
          '--instance',
          instancePath,
        ],
        capture.io,
      );

      expect(exitCode).toBe(1);
      expect(capture.stdout()).toBe('');
      expect(capture.stderr()).toContain('Deployment contract is invalid:');
      expect(capture.stderr()).toContain('unknown profile not-declared');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    [[], '--declaration is required'],
    [['--instance'], 'Missing value for --instance'],
    [['--unknown', 'value'], 'Unknown argument --unknown'],
    [
      ['--declaration', 'first.json', '--declaration', 'second.json'],
      '--declaration may be provided only once',
    ],
  ] as const)('rejects malformed arguments %#', async (argv, expected) => {
    const capture = captureIo();
    expect(await runDeploymentValidationCli(argv, capture.io)).toBe(1);
    expect(capture.stderr()).toContain(expected);
  });

  it('reports invalid JSON without attempting validation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atp-deployment-cli-json-'));
    try {
      const declarationPath = join(root, CANONICAL_CAPABILITY_DECLARATION_PATH);
      writeFileSync(declarationPath, '{"contractVersion":');
      const capture = captureIo();

      expect(await runDeploymentValidationCli(['--declaration', declarationPath], capture.io)).toBe(
        1,
      );
      expect(capture.stderr()).toContain('invalid JSON');
      expect(capture.stdout()).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
