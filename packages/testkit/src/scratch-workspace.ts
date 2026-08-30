import { access, stat } from 'node:fs/promises';
import type {
  AgentToolApplication,
  PlatformConfig,
  ScratchWorkspace,
} from '@agent-tool-platform/runtime';
import { ConformanceRun, type ConformanceOptions, type ConformanceResult } from './harness.js';

export interface ScratchWorkspaceConformanceFixture<TConfig extends PlatformConfig, TServices> {
  readonly application: AgentToolApplication<TConfig, TServices>;
  readonly workspace: ScratchWorkspace;
}

export interface ScratchWorkspaceConformanceOptions<
  TConfig extends PlatformConfig,
  TServices,
> extends ConformanceOptions {
  /** Builds a fresh, unstarted application whose services own the returned workspace. */
  readonly createApplication: () => Promise<ScratchWorkspaceConformanceFixture<TConfig, TServices>>;
}

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

/** Exercises the portable lifecycle contract for application-owned scratch workspaces. */
export const runScratchWorkspaceConformance = async <TConfig extends PlatformConfig, TServices>(
  options: ScratchWorkspaceConformanceOptions<TConfig, TServices>,
): Promise<ConformanceResult> => {
  const run = new ConformanceRun('scratch-workspace');

  const owned = await options.createApplication();
  try {
    await owned.application.start();
    const metadata = await stat(owned.workspace.path);
    run.check('the workspace exists during capability lifetime', metadata.isDirectory());
    if (process.platform === 'win32') {
      run.check(
        'Windows uses the portable directory expectation rather than POSIX mode bits',
        metadata.isDirectory(),
        'Node mode bits do not describe Windows ACLs',
      );
    } else {
      run.equal('the workspace has private POSIX permissions', metadata.mode & 0o777, 0o700);
    }
  } finally {
    await owned.application.shutdown();
  }
  run.check(
    'normal shutdown removes an owned workspace',
    !(await pathExists(owned.workspace.path)),
  );

  const manual = await options.createApplication();
  try {
    await manual.application.start();
    await Promise.all([manual.workspace.dispose(), manual.workspace.dispose()]);
    await manual.workspace.dispose();
    run.check(
      'manual disposal is idempotent and removes the workspace',
      !(await pathExists(manual.workspace.path)),
    );
  } finally {
    await manual.application.shutdown();
  }

  return run.finish(options);
};
