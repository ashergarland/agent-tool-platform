import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { badRequest, forbidden, limitExceeded, notFound, notReady } from '../errors.js';

/**
 * Generic filesystem containment.
 *
 * Extracted from the AST Summarizer workspace, the Git Optimizer repository boundary, and the Data
 * Cruncher local-path handling. What all three actually share is the *boundary*: canonicalize, then
 * check containment, then operate on the canonical path.
 *
 * What they do not share is policy, and none of it lives here. Supported file extensions, what
 * counts as a repository, which source kinds are permitted, and image rules are capability
 * concerns. A capability composes {@link RootBoundary} with its own restrictions rather than
 * asking the platform to learn them.
 */

export interface ResolvedPath {
  /** Canonical absolute path. Not safe to return to a caller. */
  readonly realPath: string;
  /** Root-relative POSIX path, which is safe to return. */
  readonly relativePath: string;
}

export interface RootBoundaryOptions {
  /** Absolute or relative directory. `undefined` means no root was configured. */
  readonly root: string | undefined;
  /** Reject inputs that resolve to something other than a regular file. Default: false. */
  readonly requireRegularFile?: boolean;
  /** Optional per-file byte ceiling enforced by {@link RootBoundary.readFile}. */
  readonly maxFileBytes?: number;
  /** Allow the root directory itself to be addressed. Default: false. */
  readonly allowRoot?: boolean;
}

export interface RootBoundaryStatus {
  readonly usable: boolean;
  readonly configured: boolean;
  readonly reason?: string;
}

const unusableRoot = (reason: string): Error =>
  notReady(`The configured root directory is unusable: ${reason}`);

/** Rejects absolute inputs, drive-relative inputs, NUL bytes, and UNC paths. */
export const assertRelativeInput = (input: string): void => {
  if (input.length === 0) throw badRequest('The path must not be empty');
  if (input.includes('\0')) throw badRequest('The path must not contain NUL bytes');
  if (input.startsWith('\\\\') || input.startsWith('//')) {
    throw badRequest('UNC paths are not supported');
  }
  if (isAbsolute(input) || /^[a-zA-Z]:/u.test(input)) {
    throw badRequest('The path must be relative to the configured root');
  }
};

/** Lower-cased extension including the leading dot, or an empty string. */
export const extensionOf = (path: string): string => {
  const separatorIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const name = path.slice(separatorIndex + 1);
  const dotIndex = name.lastIndexOf('.');
  return dotIndex <= 0 ? '' : name.slice(dotIndex).toLowerCase();
};

export class RootBoundary {
  private canonicalRoot: Promise<string> | undefined;

  public constructor(private readonly options: RootBoundaryOptions) {}

  public get configured(): boolean {
    return this.options.root !== undefined;
  }

  /** Canonicalizes the root exactly once and caches the successful result. */
  public async root(): Promise<string> {
    const configured = this.options.root;
    if (configured === undefined) throw notReady('No root directory is configured');
    this.canonicalRoot ??= (async (): Promise<string> => {
      let canonical: string;
      try {
        canonical = await realpath(resolve(configured));
      } catch {
        throw unusableRoot('it cannot be resolved');
      }
      let metadata;
      try {
        metadata = await stat(canonical);
      } catch {
        throw unusableRoot('it cannot be read');
      }
      if (!metadata.isDirectory()) throw unusableRoot('it is not a directory');
      return canonical;
    })().catch((error: unknown) => {
      this.canonicalRoot = undefined;
      throw error;
    });
    return this.canonicalRoot;
  }

  /** Readiness input. Never reads or lists contents. */
  public async status(): Promise<RootBoundaryStatus> {
    if (!this.configured) {
      return { usable: false, configured: false, reason: 'root_not_configured' };
    }
    try {
      await this.root();
      return { usable: true, configured: true };
    } catch {
      return { usable: false, configured: true, reason: 'root_unusable' };
    }
  }

  /** Formats a canonical path as a root-relative POSIX path, or throws when it escapes. */
  public formatRelative(root: string, realPath: string): string {
    const fromRoot = relative(root, realPath);
    if (fromRoot === '') {
      if (this.options.allowRoot === true) return '.';
      throw forbidden('Paths must remain within the configured root directory');
    }
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw forbidden('Paths must remain within the configured root directory');
    }
    return fromRoot.split(sep).join('/');
  }

  /** Containment test that tolerates mixed path separators. */
  public isWithin(root: string, path: string, includeRoot = false): boolean {
    if (includeRoot && resolve(path) === resolve(root)) return true;
    try {
      this.formatRelative(root, path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolves caller input to a canonical path beneath the root. Symlinks are resolved *before*
   * containment is checked, so a link whose target escapes the root is rejected rather than
   * followed.
   */
  public async resolve(input: string): Promise<ResolvedPath> {
    assertRelativeInput(input);
    const root = await this.root();
    const candidate = resolve(root, input);
    let realPath: string;
    try {
      realPath = await realpath(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') throw notFound('Path not found');
      if (code === 'EACCES' || code === 'EPERM') throw forbidden('Path is not readable');
      if (code === 'ELOOP') throw badRequest('The path contains a symbolic link loop');
      throw badRequest('The path could not be resolved');
    }
    const relativePath = this.formatRelative(root, realPath);
    if (this.options.requireRegularFile === true) {
      const metadata = await stat(realPath);
      if (!metadata.isFile()) throw badRequest('The path is not a regular file');
      this.assertSizeWithinLimit(metadata.size);
    }
    return { realPath, relativePath };
  }

  /**
   * Reads a resolved file through a single descriptor. The size is re-checked on the open
   * descriptor, so a file that grows between resolution and reading cannot exceed the limit.
   */
  public async readFile(file: ResolvedPath): Promise<{ text: string; bytes: number }> {
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    const handle = await open(file.realPath, constants.O_RDONLY | noFollow).catch(
      (error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ELOOP' || code === 'EMLINK') {
          throw forbidden('Paths must remain within the configured root directory');
        }
        if (code === 'ENOENT') throw notFound('Path not found');
        throw forbidden('Path is not readable');
      },
    );
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw badRequest('The path is not a regular file');
      this.assertSizeWithinLimit(metadata.size);
      const buffer = await handle.readFile();
      this.assertSizeWithinLimit(buffer.byteLength);
      return { text: buffer.toString('utf8'), bytes: buffer.byteLength };
    } finally {
      await handle.close();
    }
  }

  private assertSizeWithinLimit(size: number): void {
    const maxFileBytes = this.options.maxFileBytes;
    if (maxFileBytes !== undefined && size > maxFileBytes) {
      throw limitExceeded(`File exceeds the ${maxFileBytes} byte per-file limit`, {
        limit: 'maxFileBytes',
        maxFileBytes,
      });
    }
  }
}

export const createRootBoundary = (options: RootBoundaryOptions): RootBoundary =>
  new RootBoundary(options);
