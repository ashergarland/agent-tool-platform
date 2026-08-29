import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
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
  /** Optional per-file byte ceiling enforced against opened files and buffered reads. */
  readonly maxFileBytes?: number;
  /** Allow the root directory itself to be addressed. Default: false. */
  readonly allowRoot?: boolean;
}

export interface RootBoundaryStatus {
  readonly usable: boolean;
  readonly configured: boolean;
  readonly reason?: string;
}

export interface RootBoundaryOpenFileOptions {
  /** Maximum bytes copied from the start of the opened file. Default: 4096. */
  readonly previewBytes?: number;
}

export interface ConfinedReadStreamOptions {
  /** Node stream buffer size. */
  readonly highWaterMark?: number;
  /** Cancels this stream without closing the owning confined file. */
  readonly signal?: AbortSignal;
}

export interface ConfinedOpenedFile {
  /** Canonical root-relative POSIX path. */
  readonly relativePath: string;
  /** Descriptor metadata captured during validation. */
  readonly sizeBytes: number;
  /** Bounded positional read from the same descriptor used by the stream. */
  readonly preview: Buffer;
  /** Streams the validated size snapshot from the opened descriptor, never by reopening its path. */
  createReadStream(options?: ConfinedReadStreamOptions): Readable;
  /** Closes the underlying handle. Safe to call repeatedly or concurrently. */
  close(): Promise<void>;
}

const unusableRoot = (reason: string): Error =>
  notReady(`The configured root directory is unusable: ${reason}`);

const defaultPreviewBytes = 4096;
const maximumSafeFileSize = BigInt(Number.MAX_SAFE_INTEGER);

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/** @internal Deterministic identity assertion shared by the open algorithm and race tests. */
export const assertSameFileIdentity = (opened: FileIdentity, addressed: FileIdentity): void => {
  if (opened.ino === 0n || addressed.ino === 0n) {
    throw forbidden('File identity cannot be verified on this platform or filesystem');
  }
  if (opened.dev !== addressed.dev || opened.ino !== addressed.ino) {
    throw forbidden('The addressed path changed while the file was being opened');
  }
};

class ConfinedOpenedFileHandle implements ConfinedOpenedFile {
  private closed = false;
  private closing: Promise<void> | undefined;

  public constructor(
    private readonly handle: FileHandle,
    public readonly relativePath: string,
    public readonly sizeBytes: number,
    public readonly preview: Buffer,
  ) {}

  public createReadStream(options: ConfinedReadStreamOptions = {}): Readable {
    if (this.closed || this.closing !== undefined) {
      throw new Error('The confined opened file is closed');
    }

    const handle = this.handle;
    const sizeBytes = this.sizeBytes;
    let position = 0;
    let reading = false;
    let ended = false;
    return new Readable({
      objectMode: false,
      ...(options.highWaterMark === undefined ? {} : { highWaterMark: options.highWaterMark }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      read(requestedBytes): void {
        if (reading || ended) return;
        if (position >= sizeBytes) {
          ended = true;
          this.push(null);
          return;
        }

        reading = true;
        const length = Math.max(1, Math.min(requestedBytes, sizeBytes - position));
        const buffer = Buffer.allocUnsafe(length);
        void handle.read(buffer, 0, length, position).then(
          ({ bytesRead }) => {
            reading = false;
            if (this.destroyed) return;
            if (bytesRead === 0) {
              ended = true;
              this.push(null);
              return;
            }
            position += bytesRead;
            this.push(buffer.subarray(0, bytesRead));
          },
          (error: unknown) => {
            reading = false;
            this.destroy(
              error instanceof Error
                ? error
                : new Error('The confined file descriptor could not be read', { cause: error }),
            );
          },
        );
      },
    });
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closing ??= this.handle
      .close()
      .then(() => {
        this.closed = true;
      })
      .finally(() => {
        if (!this.closed) this.closing = undefined;
      });
    await this.closing;
  }
}

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
    const absoluteRoot = resolve(root);
    const absolutePath = resolve(realPath);
    const descendantPrefix = absoluteRoot.endsWith(sep) ? absoluteRoot : `${absoluteRoot}${sep}`;
    // `path.relative` is case-insensitive on Windows even for case-sensitive NTFS directories.
    // Canonical paths carry filesystem casing, so require an exact ancestor prefix first.
    if (absolutePath !== absoluteRoot && !absolutePath.startsWith(descendantPrefix)) {
      throw forbidden('Paths must remain within the configured root directory');
    }

    const fromRoot = relative(absoluteRoot, absolutePath);
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
   * Opens original caller input once, then validates and streams that same descriptor.
   *
   * POSIX uses `O_NOFOLLOW` for atomic final-component symlink rejection. Node does not expose that
   * flag on Windows, so Windows rejects a stable final symlink with `lstat` after open and requires
   * non-zero, matching descriptor/path `(dev, ino)` identity before returning. Every platform also
   * canonicalizes the addressed path after open and re-checks root containment and identity.
   */
  public async openFile(
    input: string,
    options: RootBoundaryOpenFileOptions = {},
  ): Promise<ConfinedOpenedFile> {
    assertRelativeInput(input);
    const previewBytes = options.previewBytes ?? defaultPreviewBytes;
    if (!Number.isSafeInteger(previewBytes) || previewBytes < 0) {
      throw badRequest('previewBytes must be a non-negative safe integer');
    }

    const root = await this.root();
    const candidate = resolve(root, input);
    // Enforce lexical containment before any open. Canonical containment is repeated below against
    // the object reached by the opened path, after symlinks have been resolved.
    this.formatRelative(root, candidate);

    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    const nonBlock = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0;
    const handle = await open(candidate, constants.O_RDONLY | noFollow | nonBlock).catch(
      (error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ELOOP' || code === 'EMLINK') {
          throw forbidden('The final path component must not be a symbolic link');
        }
        if (code === 'ENOENT' || code === 'ENOTDIR') throw notFound('Path not found');
        throw forbidden('Path is not readable');
      },
    );

    try {
      const openedMetadata = await handle.stat({ bigint: true });
      if (!openedMetadata.isFile()) throw badRequest('The path is not a regular file');

      const addressedMetadata = await this.pathMetadata(candidate, false);
      if (addressedMetadata.isSymbolicLink()) {
        throw forbidden('The final path component must not be a symbolic link');
      }
      if (!addressedMetadata.isFile()) throw badRequest('The path is not a regular file');
      assertSameFileIdentity(openedMetadata, addressedMetadata);

      const canonicalPath = await this.canonicalizeOpenedPath(candidate);
      const relativePath = this.formatRelative(root, canonicalPath);
      const canonicalMetadata = await this.pathMetadata(canonicalPath, true);
      if (!canonicalMetadata.isFile()) throw badRequest('The path is not a regular file');
      assertSameFileIdentity(openedMetadata, canonicalMetadata);

      // Close the validation sequence on the caller-addressed path. If the final component changed
      // after the first lstat/canonicalization pass, it must again be a non-link to this descriptor.
      const finalAddressedMetadata = await this.pathMetadata(candidate, false);
      if (finalAddressedMetadata.isSymbolicLink()) {
        throw forbidden('The final path component must not be a symbolic link');
      }
      if (!finalAddressedMetadata.isFile()) throw badRequest('The path is not a regular file');
      assertSameFileIdentity(openedMetadata, finalAddressedMetadata);

      const sizeBytes = this.openedSize(openedMetadata.size);
      const previewLength = Math.min(previewBytes, sizeBytes);
      const previewBuffer = Buffer.allocUnsafe(previewLength);
      const { bytesRead } =
        previewLength === 0
          ? { bytesRead: 0 }
          : await handle.read(previewBuffer, 0, previewLength, 0);
      const preview = Buffer.from(previewBuffer.subarray(0, bytesRead));

      return new ConfinedOpenedFileHandle(handle, relativePath, sizeBytes, preview);
    } catch (error) {
      try {
        await handle.close();
      } catch (closeError) {
        throw new AggregateError([error, closeError], 'Confined file validation and close failed', {
          cause: error,
        });
      }
      throw error;
    }
  }

  /**
   * Buffers a confined file for compatibility. Passing original input gets the full open-time
   * guarantees; the legacy {@link ResolvedPath} overload re-checks that path beneath this boundary
   * before using the same descriptor-backed primitive.
   */
  public async readFile(input: string): Promise<{ text: string; bytes: number }>;
  public async readFile(file: ResolvedPath): Promise<{ text: string; bytes: number }>;
  public async readFile(input: string | ResolvedPath): Promise<{ text: string; bytes: number }> {
    const relativeInput =
      typeof input === 'string'
        ? input
        : this.formatRelative(await this.root(), resolve(input.realPath));
    const opened = await this.openFile(relativeInput, { previewBytes: 0 });
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of opened.createReadStream()) {
        if (!Buffer.isBuffer(chunk)) throw new Error('Confined file streams must emit buffers');
        chunks.push(chunk);
        bytes += chunk.byteLength;
        this.assertSizeWithinLimit(bytes);
      }
      const buffer = Buffer.concat(chunks, bytes);
      return { text: buffer.toString('utf8'), bytes };
    } finally {
      await opened.close();
    }
  }

  private async canonicalizeOpenedPath(path: string): Promise<string> {
    try {
      return await realpath(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') throw notFound('Path not found');
      if (code === 'EACCES' || code === 'EPERM') throw forbidden('Path is not readable');
      if (code === 'ELOOP') throw forbidden('The path contains a symbolic link loop');
      throw badRequest('The path could not be resolved');
    }
  }

  private async pathMetadata(path: string, follow: boolean): Promise<BigIntStats> {
    try {
      return follow ? await stat(path, { bigint: true }) : await lstat(path, { bigint: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') throw notFound('Path not found');
      if (code === 'EACCES' || code === 'EPERM') throw forbidden('Path is not readable');
      throw badRequest('Path metadata could not be read');
    }
  }

  private openedSize(size: bigint): number {
    const maxFileBytes = this.options.maxFileBytes;
    if (
      maxFileBytes !== undefined &&
      Number.isFinite(maxFileBytes) &&
      size > BigInt(Math.floor(maxFileBytes))
    ) {
      throw limitExceeded(`File exceeds the ${maxFileBytes} byte per-file limit`, {
        limit: 'maxFileBytes',
        maxFileBytes,
      });
    }
    if (size > maximumSafeFileSize) {
      throw limitExceeded('File size exceeds the largest safely representable byte count', {
        limit: 'safeFileSize',
        maxFileBytes: Number.MAX_SAFE_INTEGER,
      });
    }
    return Number(size);
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
