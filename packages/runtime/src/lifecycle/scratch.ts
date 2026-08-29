import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { combineErrors } from './failures.js';

const defaultPrefix = 'agent-tool-';
const privateDirectoryMode = 0o700;

export interface ScratchWorkspaceOptions {
  /** Filename prefix for the atomically created directory. Default: `agent-tool-`. */
  readonly prefix?: string;
  /** Existing parent directory. Defaults to the operating system temporary directory. */
  readonly parentDirectory?: string;
}

export interface ScratchWorkspace {
  /** Absolute path to the private temporary directory. */
  readonly path: string;
  /** Removes the directory recursively. Safe to call repeatedly or concurrently. */
  dispose(): Promise<void>;
}

const validatePrefix = (prefix: string): void => {
  if (
    prefix.length === 0 ||
    prefix === '.' ||
    prefix === '..' ||
    prefix.includes('\0') ||
    prefix.includes('/') ||
    prefix.includes('\\')
  ) {
    throw new TypeError('Scratch workspace prefixes must be non-empty filename prefixes');
  }
};

class OwnedScratchWorkspace implements ScratchWorkspace {
  private disposed = false;
  private disposal: Promise<void> | undefined;

  public constructor(
    public readonly path: string,
    private readonly release: () => void,
  ) {}

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposal ??= rm(this.path, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    })
      .then(() => {
        this.disposed = true;
        this.release();
      })
      .finally(() => {
        if (!this.disposed) this.disposal = undefined;
      });
    await this.disposal;
  }
}

/**
 * Application-owned scratch tracking. This is internal lifecycle machinery; only the workspace
 * types and the capability-context creation function are public.
 */
export class ScratchWorkspaceOwner {
  private readonly workspaces = new Set<OwnedScratchWorkspace>();
  private closed = false;

  public async create(options: ScratchWorkspaceOptions = {}): Promise<ScratchWorkspace> {
    if (this.closed) throw new Error('The application is no longer accepting scratch workspaces');

    const prefix = options.prefix ?? defaultPrefix;
    validatePrefix(prefix);
    const parent = resolve(options.parentDirectory ?? tmpdir());
    const path = await mkdtemp(join(parent, prefix));

    try {
      // Node creates mkdtemp directories with private permissions on POSIX. Reapply the intended
      // mode before publishing the path so the contract does not depend on the process umask.
      if (process.platform !== 'win32') await chmod(path, privateDirectoryMode);

      if (this.closed) {
        await rm(path, { recursive: true, force: true });
        throw new Error('The application is no longer accepting scratch workspaces');
      }

      const workspace = new OwnedScratchWorkspace(path, () => this.workspaces.delete(workspace));
      this.workspaces.add(workspace);
      return workspace;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try {
        await rm(path, { recursive: true, force: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      throw combineErrors(error, cleanupErrors, 'Scratch workspace creation and cleanup failed');
    }
  }

  /** Closes creation and attempts every owned cleanup, returning all failures to the lifecycle. */
  public async disposeAll(): Promise<readonly unknown[]> {
    this.closed = true;
    const settled = await Promise.allSettled(
      [...this.workspaces].map((workspace) => workspace.dispose()),
    );
    const errors: unknown[] = [];
    for (const result of settled) {
      if (result.status === 'rejected') errors.push(result.reason as unknown);
    }
    return errors;
  }
}
