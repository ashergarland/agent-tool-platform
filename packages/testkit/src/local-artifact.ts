import { access, appendFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import {
  NpmArtifactMaterializationError,
  buildChildEnvironment,
  materializeNpmLocalArtifact,
  runBoundedProcess,
  verifyNpmLocalArtifact,
  type NpmArtifactMaterializationOptions,
  type NpmLocalArtifactSpec,
} from '@agent-tool-platform/runtime';
import { ConformanceRun, type ConformanceOptions, type ConformanceResult } from './harness.js';

export interface NpmLocalArtifactConformanceOptions extends ConformanceOptions {
  readonly spec: NpmLocalArtifactSpec;
  readonly materialization: NpmArtifactMaterializationOptions;
  readonly expectedOutput?: string;
  readonly lifecycleMarkerName?: string;
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

export const runNpmLocalArtifactConformance = async (
  options: NpmLocalArtifactConformanceOptions,
): Promise<ConformanceResult> => {
  const run = new ConformanceRun('npm-local-artifact');
  const first = await materializeNpmLocalArtifact(options.spec, options.materialization);
  run.equal('the first call materializes the exact artifact', first.disposition, 'materialized');
  run.check(
    'the layout is derived from immutable identity',
    /^artifacts\/npm\/sha256-[0-9a-f]{64}$/u.test(first.layout),
  );

  const second = await materializeNpmLocalArtifact(options.spec, options.materialization);
  run.equal(
    'repeated materialization verifies instead of reinstalling',
    second.disposition,
    'already-materialized',
  );
  run.equal('repeated materialization keeps one layout', second.layout, first.layout);
  run.equal(
    'repeated materialization keeps one installation digest',
    second.verification.installationDigest,
    first.verification.installationDigest,
  );

  const verified = await verifyNpmLocalArtifact(options.spec, options.materialization);
  run.equal(
    'verification succeeds without reinstalling',
    verified.disposition,
    'already-materialized',
  );
  const canonicalRoot = await realpath(options.materialization.root);
  const fromRoot = relative(canonicalRoot, verified.launch.entrypointPath);
  const entrypointConfined =
    fromRoot.length > 0 &&
    fromRoot !== '..' &&
    !fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(fromRoot);
  run.check('the verified entrypoint stays beneath the consumer root', entrypointConfined);
  if (!entrypointConfined) return run.finish(options);

  const execution = await runBoundedProcess({
    executablePath: verified.launch.executablePath,
    label: 'prepared npm artifact',
    args: [verified.launch.entrypointPath],
    cwd: dirname(verified.launch.entrypointPath),
    env: buildChildEnvironment({
      pathEntries: [dirname(verified.launch.executablePath)],
      tempDir: options.materialization.root,
    }),
    timeoutMs: 15_000,
    maxOutputBytes: 64 * 1024,
    maxStderrBytes: 8 * 1024,
  });
  run.equal('the prepared launch exits successfully', execution.code, 0);
  if (options.expectedOutput !== undefined) {
    run.equal(
      'the prepared launch invokes the selected bin',
      execution.stdout,
      options.expectedOutput,
    );
  }

  if (options.lifecycleMarkerName !== undefined) {
    const packagePath = join(
      options.materialization.root,
      ...verified.layout.split('/'),
      'node_modules',
      ...options.spec.packageName.split('/'),
    );
    run.check(
      'npm lifecycle scripts are not executed',
      !(await exists(join(packagePath, options.lifecycleMarkerName))),
    );
  }

  await appendFile(verified.launch.entrypointPath, '\n// conformance corruption\n', 'utf8');
  await run.throws(
    'corrupted installations are rejected',
    () => verifyNpmLocalArtifact(options.spec, options.materialization),
    (error) =>
      error instanceof NpmArtifactMaterializationError && error.code === 'corrupt-installation',
  );

  return run.finish(options);
};
