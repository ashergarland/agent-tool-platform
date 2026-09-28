import { randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rm,
  stat,
  type FileHandle,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  parsePreparedAgentInstance,
  serializePreparedAgentInstance,
  type PreparedAgentInstance,
} from '@agent-tool-platform/agent-kit';
import { RootBoundary, type ConfinedOpenedFile } from '@agent-tool-platform/runtime/fs';

export const AGENT_TOOL_PLATFORM_STATE_DIR = 'AGENT_TOOL_PLATFORM_STATE_DIR';
const INSTANCES_DIRECTORY_NAME = 'instances';
export const MAX_INSTANCE_RECORD_BYTES = 128 * 1024;
export const MAX_DISCOVERY_RECORDS = 100;
const MAX_DISCOVERY_DIRECTORY_ENTRIES = 1_000;
const INSTANCE_FILE_PATTERN = /^[0-9a-f]{64}\.json$/u;
const INSTANCE_ID_PATTERN = /^sha256:([0-9a-f]{64})$/u;

export interface BuilderInstanceDiscovery {
  readonly instances: readonly PreparedAgentInstance[];
  readonly diagnostics: {
    readonly inspectedRecordCount: number;
    readonly invalidRecordCount: number;
    readonly truncated: boolean;
    readonly warnings: readonly string[];
  };
}

export interface BuilderInstanceStore {
  get(instanceId: string): Promise<PreparedAgentInstance | undefined>;
  put(instance: PreparedAgentInstance): Promise<void>;
  list(): Promise<BuilderInstanceDiscovery>;
}

/** @internal Deterministic race/failure points used only by filesystem tests. */
export interface BuilderInstanceStoreFileSystemHooks {
  readonly afterReadDescriptorValidated?: (recordPath: string) => Promise<void> | void;
  readonly afterTemporaryFileValidated?: (temporaryPath: string) => Promise<void> | void;
  readonly beforeAtomicReplace?: (
    temporaryPath: string,
    targetPath: string,
  ) => Promise<void> | void;
}

export class BuilderInstanceStoreError extends Error {
  public override readonly name = 'BuilderInstanceStoreError';

  public constructor(
    public readonly operation: 'discover' | 'read' | 'write',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const isNodeError = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

export const instanceFileName = (instanceId: string): string => {
  const match = INSTANCE_ID_PATTERN.exec(instanceId);
  if (match === null) {
    throw new BuilderInstanceStoreError(
      'read',
      'The Agent Instance ID cannot be mapped to a local record.',
    );
  }
  return `${match[1]}.json`;
};

export const resolveBuilderStateRoot = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  userHome = homedir(),
): string => {
  const configured = environment[AGENT_TOOL_PLATFORM_STATE_DIR];
  if (configured !== undefined) {
    if (configured.trim().length === 0) {
      throw new BuilderInstanceStoreError(
        'read',
        `${AGENT_TOOL_PLATFORM_STATE_DIR} must not be empty.`,
      );
    }
    return resolve(configured);
  }
  return join(userHome, '.agent-tool-platform');
};

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const sortInstances = (
  instances: readonly PreparedAgentInstance[],
): readonly PreparedAgentInstance[] =>
  [...instances].sort((left, right) => {
    const preparedDifference = Date.parse(right.preparedAt) - Date.parse(left.preparedAt);
    return preparedDifference === 0
      ? compareCodeUnits(left.instanceId, right.instanceId)
      : preparedDifference;
  });

type StoreOperation = 'discover' | 'read' | 'write';

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface ValidatedPath {
  readonly canonicalPath: string;
  readonly identity: FileIdentity;
  readonly sizeBytes: number;
}

interface ValidatedDirectory extends ValidatedPath {
  readonly addressedPath: string;
  readonly handle: FileHandle;
}

interface StoreDirectories {
  readonly stateRoot: ValidatedDirectory;
  readonly instances: ValidatedDirectory;
}

interface OpenedValidatedFile extends ValidatedPath {
  readonly handle: FileHandle;
}

const fileIdentity = (metadata: Pick<BigIntStats, 'dev' | 'ino'>): FileIdentity => ({
  dev: metadata.dev,
  ino: metadata.ino,
});

const assertVerifiableIdentity = (
  identity: FileIdentity,
  operation: StoreOperation,
  description: string,
): void => {
  if (identity.dev === 0n || identity.ino === 0n) {
    throw new BuilderInstanceStoreError(
      operation,
      `${description} identity cannot be verified on this filesystem.`,
    );
  }
};

const assertSameIdentity = (
  expected: FileIdentity,
  actual: FileIdentity,
  operation: StoreOperation,
  description: string,
): void => {
  assertVerifiableIdentity(expected, operation, description);
  assertVerifiableIdentity(actual, operation, description);
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) {
    throw new BuilderInstanceStoreError(
      operation,
      `${description} changed while it was being validated.`,
    );
  }
};

const openDirectoryFlags =
  constants.O_RDONLY |
  (typeof constants.O_DIRECTORY === 'number' ? constants.O_DIRECTORY : 0) |
  (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);

const openFileFlags =
  constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);

const validateOpenedPath = async (
  handle: FileHandle,
  addressedPath: string,
  operation: StoreOperation,
  kind: 'directory' | 'file',
  description: string,
  canonicalParent?: string,
): Promise<ValidatedPath> => {
  const assertExpectedMetadata = (
    metadata: BigIntStats,
    representation: 'opened' | 'addressed' | 'canonical' | 'final',
  ): void => {
    const expectedKind = kind === 'directory' ? metadata.isDirectory() : metadata.isFile();
    const withinLimit = kind === 'directory' || metadata.size <= BigInt(MAX_INSTANCE_RECORD_BYTES);
    if (
      (representation === 'addressed' || representation === 'final') &&
      metadata.isSymbolicLink()
    ) {
      throw new BuilderInstanceStoreError(
        operation,
        `${description} is a symbolic-link or reparse-point representation.`,
      );
    }
    if (!expectedKind || !withinLimit) {
      throw new BuilderInstanceStoreError(
        operation,
        `${description} is not a bounded ${kind === 'file' ? 'regular file' : 'directory'}.`,
      );
    }
  };

  const openedMetadata = await handle.stat({ bigint: true });
  assertExpectedMetadata(openedMetadata, 'opened');
  const identity = fileIdentity(openedMetadata);
  assertVerifiableIdentity(identity, operation, description);

  const addressedMetadata = await lstat(addressedPath, { bigint: true });
  assertExpectedMetadata(addressedMetadata, 'addressed');
  assertSameIdentity(identity, fileIdentity(addressedMetadata), operation, description);

  const canonicalPath = await realpath(addressedPath);
  if (canonicalParent !== undefined && dirname(canonicalPath) !== canonicalParent) {
    throw new BuilderInstanceStoreError(
      operation,
      `${description} escapes its configured directory.`,
    );
  }
  const canonicalMetadata = await stat(canonicalPath, { bigint: true });
  assertExpectedMetadata(canonicalMetadata, 'canonical');
  assertSameIdentity(identity, fileIdentity(canonicalMetadata), operation, description);

  const finalAddressedMetadata = await lstat(addressedPath, { bigint: true });
  assertExpectedMetadata(finalAddressedMetadata, 'final');
  assertSameIdentity(identity, fileIdentity(finalAddressedMetadata), operation, description);

  return {
    canonicalPath,
    identity,
    sizeBytes: kind === 'file' ? Number(openedMetadata.size) : 0,
  };
};

const openValidatedDirectory = async (
  addressedPath: string,
  operation: StoreOperation,
  expectedParent?: ValidatedDirectory,
): Promise<ValidatedDirectory> => {
  const handle = await open(addressedPath, openDirectoryFlags);
  try {
    const validated = await validateOpenedPath(
      handle,
      addressedPath,
      operation,
      'directory',
      'The local Agent Instance directory',
      expectedParent?.canonicalPath,
    );
    return { ...validated, addressedPath, handle };
  } catch (error) {
    try {
      await handle.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError]);
    }
    throw error;
  }
};

const verifyValidatedDirectory = async (
  directory: ValidatedDirectory,
  operation: StoreOperation,
): Promise<void> => {
  const validated = await validateOpenedPath(
    directory.handle,
    directory.addressedPath,
    operation,
    'directory',
    'The local Agent Instance directory',
  );
  assertSameIdentity(
    directory.identity,
    validated.identity,
    operation,
    'The local Agent Instance directory',
  );
  if (validated.canonicalPath !== directory.canonicalPath) {
    throw new BuilderInstanceStoreError(
      operation,
      'The canonical local Agent Instance directory changed during the operation.',
    );
  }
};

const pathIsMissing = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return true;
    throw error;
  }
};

const openStoreDirectories = async (
  stateRoot: string,
  operation: StoreOperation,
  create: boolean,
): Promise<StoreDirectories | undefined> => {
  if (create) {
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  } else if (await pathIsMissing(stateRoot)) {
    return undefined;
  }

  const stateRootDirectory = await openValidatedDirectory(stateRoot, operation);
  try {
    const instancesPath = join(stateRoot, INSTANCES_DIRECTORY_NAME);
    if (create) {
      await verifyValidatedDirectory(stateRootDirectory, operation);
      await mkdir(instancesPath, { recursive: true, mode: 0o700 });
    } else if (await pathIsMissing(instancesPath)) {
      await verifyValidatedDirectory(stateRootDirectory, operation);
      await stateRootDirectory.handle.close();
      return undefined;
    }

    const instancesDirectory = await openValidatedDirectory(
      instancesPath,
      operation,
      stateRootDirectory,
    );
    try {
      await verifyValidatedDirectory(stateRootDirectory, operation);
      await verifyValidatedDirectory(instancesDirectory, operation);
      return { stateRoot: stateRootDirectory, instances: instancesDirectory };
    } catch (error) {
      try {
        await instancesDirectory.handle.close();
      } catch (closeError) {
        throw new AggregateError([error, closeError]);
      }
      throw error;
    }
  } catch (error) {
    try {
      await stateRootDirectory.handle.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError]);
    }
    throw error;
  }
};

const closeStoreDirectories = async (directories: StoreDirectories): Promise<void> => {
  const results = await Promise.allSettled([
    directories.instances.handle.close(),
    directories.stateRoot.handle.close(),
  ]);
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === 'rejected') failures.push(result.reason as unknown);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures);
};

const withStoreDirectories = async <Result>(
  directories: StoreDirectories,
  action: () => Promise<Result>,
): Promise<Result> => {
  const outcome:
    | { readonly success: true; readonly value: Result }
    | { readonly success: false; readonly error: unknown } = await action().then(
    (value) => ({ success: true, value }),
    (error: unknown) => ({ success: false, error }),
  );
  try {
    await closeStoreDirectories(directories);
  } catch (closeError) {
    if (!outcome.success) {
      throw new AggregateError([outcome.error, closeError]);
    }
    throw closeError;
  }
  if (!outcome.success) throw outcome.error;
  return outcome.value;
};

const verifyStoreDirectories = async (
  directories: StoreDirectories,
  operation: StoreOperation,
): Promise<void> => {
  await verifyValidatedDirectory(directories.stateRoot, operation);
  await verifyValidatedDirectory(directories.instances, operation);
  if (dirname(directories.instances.canonicalPath) !== directories.stateRoot.canonicalPath) {
    throw new BuilderInstanceStoreError(
      operation,
      'The local Agent Instance directory escapes the configured state root.',
    );
  }
};

const validateOpenedRegularFile = async (
  handle: FileHandle,
  addressedPath: string,
  canonicalParent: string,
  operation: StoreOperation,
): Promise<ValidatedPath> =>
  validateOpenedPath(
    handle,
    addressedPath,
    operation,
    'file',
    'The local Agent Instance record',
    canonicalParent,
  );

const openValidatedRegularFile = async (
  addressedPath: string,
  canonicalParent: string,
  operation: StoreOperation,
): Promise<OpenedValidatedFile> => {
  const handle = await open(addressedPath, openFileFlags);
  try {
    const validated = await validateOpenedRegularFile(
      handle,
      addressedPath,
      canonicalParent,
      operation,
    );
    return { ...validated, handle };
  } catch (error) {
    try {
      await handle.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError]);
    }
    throw error;
  }
};

const captureExistingFileIdentity = async (
  addressedPath: string,
  canonicalParent: string,
  operation: StoreOperation,
): Promise<FileIdentity | undefined> => {
  let opened: OpenedValidatedFile;
  try {
    opened = await openValidatedRegularFile(addressedPath, canonicalParent, operation);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      try {
        await lstat(addressedPath);
      } catch (pathError) {
        if (isNodeError(pathError, 'ENOENT')) return undefined;
        throw pathError;
      }
      throw new BuilderInstanceStoreError(
        operation,
        'The local Agent Instance record path exists but could not be opened safely.',
        { cause: error },
      );
    }
    throw error;
  }
  try {
    return opened.identity;
  } finally {
    await opened.handle.close();
  }
};

const assertExistingTargetUnchanged = async (
  targetPath: string,
  canonicalParent: string,
  expectedIdentity: FileIdentity | undefined,
): Promise<void> => {
  const currentIdentity = await captureExistingFileIdentity(targetPath, canonicalParent, 'write');
  if (expectedIdentity === undefined) {
    if (currentIdentity !== undefined) {
      throw new BuilderInstanceStoreError(
        'write',
        'The local Agent Instance target appeared before atomic replacement.',
      );
    }
    return;
  }
  if (currentIdentity === undefined) {
    throw new BuilderInstanceStoreError(
      'write',
      'The local Agent Instance target disappeared before atomic replacement.',
    );
  }
  assertSameIdentity(expectedIdentity, currentIdentity, 'write', 'The local Agent Instance target');
};

const readConfinedText = async (opened: ConfinedOpenedFile): Promise<string> => {
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  for await (const chunk of opened.createReadStream()) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytesRead += buffer.byteLength;
    if (bytesRead > MAX_INSTANCE_RECORD_BYTES) {
      throw new BuilderInstanceStoreError(
        'read',
        'The local Agent Instance record exceeds the read limit.',
      );
    }
    chunks.push(buffer);
  }
  if (bytesRead !== opened.sizeBytes) {
    throw new BuilderInstanceStoreError(
      'read',
      'The local Agent Instance record changed while it was being read.',
    );
  }
  return Buffer.concat(chunks, bytesRead).toString('utf8');
};

const readRecord = async (
  directories: StoreDirectories,
  expectedFileName: string,
  hooks: BuilderInstanceStoreFileSystemHooks,
  operation: 'discover' | 'read',
): Promise<
  | { readonly valid: true; readonly instance: PreparedAgentInstance }
  | { readonly valid: false; readonly missing: boolean }
> => {
  let opened: ConfinedOpenedFile | undefined;
  try {
    let text: string;
    try {
      const boundary = new RootBoundary({
        root: directories.instances.canonicalPath,
        requireRegularFile: true,
        maxFileBytes: MAX_INSTANCE_RECORD_BYTES,
      });
      opened = await boundary.openFile(expectedFileName, { previewBytes: 0 });
      await hooks.afterReadDescriptorValidated?.(
        join(directories.instances.canonicalPath, expectedFileName),
      );
      text = await readConfinedText(opened);
    } catch (error) {
      await verifyStoreDirectories(directories, operation);
      let missing =
        isNodeError(error, 'ENOENT') ||
        (error instanceof Error && 'code' in error && error.code === 'not_found');
      if (missing) {
        try {
          await lstat(join(directories.instances.canonicalPath, expectedFileName));
          missing = false;
        } catch (pathError) {
          missing = isNodeError(pathError, 'ENOENT');
        }
      }
      return { valid: false, missing };
    }

    await verifyStoreDirectories(directories, operation);
    try {
      const instance = parsePreparedAgentInstance(text);
      if (instanceFileName(instance.instanceId) !== expectedFileName) {
        return { valid: false, missing: false };
      }
      return { valid: true, instance };
    } catch {
      return { valid: false, missing: false };
    }
  } finally {
    await opened?.close();
  }
};

const readOpenedFileText = async (
  opened: OpenedValidatedFile,
  addressedPath: string,
  canonicalParent: string,
): Promise<string> => {
  const buffer = Buffer.alloc(opened.sizeBytes);
  let bytesRead = 0;
  while (bytesRead < buffer.byteLength) {
    const result = await opened.handle.read(
      buffer,
      bytesRead,
      buffer.byteLength - bytesRead,
      bytesRead,
    );
    if (result.bytesRead === 0) break;
    bytesRead += result.bytesRead;
  }
  if (bytesRead !== opened.sizeBytes) {
    throw new BuilderInstanceStoreError(
      'write',
      'The persisted Agent Instance changed while it was being verified.',
    );
  }
  const finalValidation = await validateOpenedRegularFile(
    opened.handle,
    addressedPath,
    canonicalParent,
    'write',
  );
  assertSameIdentity(
    opened.identity,
    finalValidation.identity,
    'write',
    'The persisted Agent Instance record',
  );
  return buffer.toString('utf8');
};

const removeValidatedTemporaryFile = async (
  temporaryPath: string,
  canonicalParent: string,
  expectedIdentity: FileIdentity | undefined,
): Promise<void> => {
  if (expectedIdentity === undefined) return;
  const currentIdentity = await captureExistingFileIdentity(
    temporaryPath,
    canonicalParent,
    'write',
  );
  if (currentIdentity === undefined) return;
  assertSameIdentity(
    expectedIdentity,
    currentIdentity,
    'write',
    'The local Agent Instance temporary file',
  );
  await rm(temporaryPath);
};

const atomicWrite = async (
  directories: StoreDirectories,
  fileName: string,
  contents: string,
  hooks: BuilderInstanceStoreFileSystemHooks,
): Promise<void> => {
  if (Buffer.byteLength(contents) > MAX_INSTANCE_RECORD_BYTES) {
    throw new BuilderInstanceStoreError(
      'write',
      'The canonical Prepared Agent Instance exceeds the local record limit.',
    );
  }
  const targetPath = join(directories.instances.canonicalPath, fileName);
  const temporaryPath = join(
    directories.instances.canonicalPath,
    `.${fileName}.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  const expectedTargetIdentity = await captureExistingFileIdentity(
    targetPath,
    directories.instances.canonicalPath,
    'write',
  );
  let temporaryHandle: FileHandle | undefined;
  let temporaryIdentity: FileIdentity | undefined;
  let replaced = false;
  let failure: unknown;

  try {
    temporaryHandle = await open(temporaryPath, 'wx', 0o600);
    const initialTemporary = await validateOpenedRegularFile(
      temporaryHandle,
      temporaryPath,
      directories.instances.canonicalPath,
      'write',
    );
    temporaryIdentity = initialTemporary.identity;
    await temporaryHandle.writeFile(contents, 'utf8');
    await temporaryHandle.sync();
    const writtenTemporary = await validateOpenedRegularFile(
      temporaryHandle,
      temporaryPath,
      directories.instances.canonicalPath,
      'write',
    );
    assertSameIdentity(
      temporaryIdentity,
      writtenTemporary.identity,
      'write',
      'The local Agent Instance temporary file',
    );
    if (writtenTemporary.sizeBytes !== Buffer.byteLength(contents)) {
      throw new BuilderInstanceStoreError(
        'write',
        'The local Agent Instance temporary file has an unexpected size.',
      );
    }
    await temporaryHandle.close();
    temporaryHandle = undefined;

    await hooks.afterTemporaryFileValidated?.(temporaryPath);
    await hooks.beforeAtomicReplace?.(temporaryPath, targetPath);

    await verifyStoreDirectories(directories, 'write');
    const reopenedTemporary = await openValidatedRegularFile(
      temporaryPath,
      directories.instances.canonicalPath,
      'write',
    );
    try {
      assertSameIdentity(
        temporaryIdentity,
        reopenedTemporary.identity,
        'write',
        'The local Agent Instance temporary file',
      );
    } finally {
      await reopenedTemporary.handle.close();
    }
    await assertExistingTargetUnchanged(
      targetPath,
      directories.instances.canonicalPath,
      expectedTargetIdentity,
    );
    await verifyStoreDirectories(directories, 'write');

    await rename(temporaryPath, targetPath);
    replaced = true;

    await verifyStoreDirectories(directories, 'write');
    const persisted = await openValidatedRegularFile(
      targetPath,
      directories.instances.canonicalPath,
      'write',
    );
    try {
      assertSameIdentity(
        temporaryIdentity,
        persisted.identity,
        'write',
        'The persisted Agent Instance record',
      );
      const persistedText = await readOpenedFileText(
        persisted,
        targetPath,
        directories.instances.canonicalPath,
      );
      if (persistedText !== contents) {
        throw new BuilderInstanceStoreError(
          'write',
          'The persisted Agent Instance record is not the canonical serialized record.',
        );
      }
      const parsed = parsePreparedAgentInstance(persistedText);
      if (instanceFileName(parsed.instanceId) !== fileName) {
        throw new BuilderInstanceStoreError(
          'write',
          'The persisted Agent Instance record does not match its requested identity.',
        );
      }
    } finally {
      await persisted.handle.close();
    }
  } catch (error) {
    failure = error;
  }

  const cleanupFailures: unknown[] = [];
  if (temporaryHandle !== undefined) {
    try {
      await temporaryHandle.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (!replaced) {
    try {
      await removeValidatedTemporaryFile(
        temporaryPath,
        directories.instances.canonicalPath,
        temporaryIdentity,
      );
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  if (failure !== undefined || cleanupFailures.length > 0) {
    const causes = [...(failure === undefined ? [] : [failure]), ...cleanupFailures];
    throw new BuilderInstanceStoreError(
      'write',
      'The Prepared Agent Instance could not be written atomically.',
      { cause: causes.length === 1 ? causes[0] : new AggregateError(causes) },
    );
  }
};

export interface FileSystemBuilderInstanceStoreOptions {
  readonly stateRoot?: string;
  readonly fileSystemHooks?: BuilderInstanceStoreFileSystemHooks;
}

export const createFileSystemBuilderInstanceStore = (
  options: FileSystemBuilderInstanceStoreOptions = {},
): BuilderInstanceStore => {
  const stateRoot = resolve(options.stateRoot ?? resolveBuilderStateRoot());
  const hooks = options.fileSystemHooks ?? {};

  return {
    async get(instanceId) {
      const fileName = instanceFileName(instanceId);
      let directories: StoreDirectories | undefined;
      try {
        directories = await openStoreDirectories(stateRoot, 'read', false);
      } catch (error) {
        if (error instanceof BuilderInstanceStoreError) throw error;
        throw new BuilderInstanceStoreError(
          'read',
          'The local Agent Instance directory could not be opened safely.',
          { cause: error },
        );
      }
      if (directories === undefined) return undefined;
      return withStoreDirectories(directories, async () => {
        const record = await readRecord(directories, fileName, hooks, 'read');
        if (record.valid) return record.instance;
        if (record.missing) return undefined;
        throw new BuilderInstanceStoreError('read', 'The local Agent Instance record is invalid.');
      });
    },

    async put(instanceInput) {
      const instance = parsePreparedAgentInstance(instanceInput);
      const fileName = instanceFileName(instance.instanceId);
      try {
        const directories = await openStoreDirectories(stateRoot, 'write', true);
        if (directories === undefined) {
          throw new BuilderInstanceStoreError(
            'write',
            'The local Agent Instance directory could not be created.',
          );
        }
        await withStoreDirectories(directories, async () =>
          atomicWrite(directories, fileName, serializePreparedAgentInstance(instance), hooks),
        );
      } catch (error) {
        if (error instanceof BuilderInstanceStoreError) throw error;
        throw new BuilderInstanceStoreError(
          'write',
          'The Prepared Agent Instance could not be persisted.',
          { cause: error },
        );
      }
    },

    async list() {
      const candidates: string[] = [];
      let directoryEntries = 0;
      let truncated = false;
      let directories: StoreDirectories | undefined;
      try {
        directories = await openStoreDirectories(stateRoot, 'discover', false);
      } catch (error) {
        if (error instanceof BuilderInstanceStoreError) throw error;
        throw new BuilderInstanceStoreError(
          'discover',
          'The local Agent Instance directory could not be opened safely.',
          { cause: error },
        );
      }
      if (directories === undefined) {
        return {
          instances: [],
          diagnostics: {
            inspectedRecordCount: 0,
            invalidRecordCount: 0,
            truncated: false,
            warnings: [],
          },
        };
      }

      return withStoreDirectories(directories, async () => {
        try {
          const directory = await opendir(directories.instances.canonicalPath);
          for await (const entry of directory) {
            directoryEntries += 1;
            if (directoryEntries > MAX_DISCOVERY_DIRECTORY_ENTRIES) {
              truncated = true;
              break;
            }
            if (!INSTANCE_FILE_PATTERN.test(entry.name)) continue;
            if (candidates.length === MAX_DISCOVERY_RECORDS) {
              truncated = true;
              break;
            }
            candidates.push(entry.name);
          }
          await verifyStoreDirectories(directories, 'discover');
        } catch (error) {
          throw new BuilderInstanceStoreError(
            'discover',
            'Local Agent Instances could not be discovered.',
            { cause: error },
          );
        }

        const instances: PreparedAgentInstance[] = [];
        let invalidRecordCount = 0;
        for (const fileName of candidates) {
          const record = await readRecord(directories, fileName, hooks, 'discover');
          if (record.valid) instances.push(record.instance);
          else invalidRecordCount += 1;
        }
        await verifyStoreDirectories(directories, 'discover');
        const warnings = [
          ...(invalidRecordCount === 0
            ? []
            : [
                `${String(invalidRecordCount)} local instance ${
                  invalidRecordCount === 1 ? 'record is' : 'records are'
                } invalid and were not returned.`,
              ]),
          ...(truncated
            ? [
                `Local instance discovery inspected at most ${String(
                  MAX_DISCOVERY_RECORDS,
                )} records.`,
              ]
            : []),
        ];
        return {
          instances: sortInstances(instances),
          diagnostics: {
            inspectedRecordCount: candidates.length,
            invalidRecordCount,
            truncated,
            warnings,
          },
        };
      });
    },
  };
};

export const createInMemoryBuilderInstanceStore = (): BuilderInstanceStore => {
  const records = new Map<string, string>();
  return {
    get(instanceId) {
      const record = records.get(instanceFileName(instanceId));
      return Promise.resolve(record === undefined ? undefined : parsePreparedAgentInstance(record));
    },
    put(instanceInput) {
      const instance = parsePreparedAgentInstance(instanceInput);
      records.set(instanceFileName(instance.instanceId), serializePreparedAgentInstance(instance));
      return Promise.resolve();
    },
    list() {
      const instances = [...records.values()].map((record) => parsePreparedAgentInstance(record));
      return Promise.resolve({
        instances: sortInstances(instances),
        diagnostics: {
          inspectedRecordCount: instances.length,
          invalidRecordCount: 0,
          truncated: false,
          warnings: [],
        },
      });
    },
  };
};
