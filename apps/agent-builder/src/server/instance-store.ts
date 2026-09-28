import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  parsePreparedAgentInstance,
  serializePreparedAgentInstance,
  type PreparedAgentInstance,
} from '@agent-tool-platform/agent-kit';

export const AGENT_TOOL_PLATFORM_STATE_DIR = 'AGENT_TOOL_PLATFORM_STATE_DIR';
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

const readBoundedText = async (
  recordPath: string,
): Promise<{ readonly valid: true; readonly text: string } | { readonly valid: false }> => {
  const metadata = await lstat(recordPath);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size > MAX_INSTANCE_RECORD_BYTES
  ) {
    return { valid: false };
  }

  const flags =
    process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(recordPath, flags);
  try {
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile() || openedMetadata.size > MAX_INSTANCE_RECORD_BYTES) {
      return { valid: false };
    }
    const buffer = Buffer.alloc(MAX_INSTANCE_RECORD_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      const result = await handle.read(buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAX_INSTANCE_RECORD_BYTES) return { valid: false };
    return { valid: true, text: buffer.subarray(0, bytesRead).toString('utf8') };
  } finally {
    await handle.close();
  }
};

const readRecord = async (
  recordPath: string,
  expectedFileName: string,
): Promise<
  { readonly valid: true; readonly instance: PreparedAgentInstance } | { readonly valid: false }
> => {
  try {
    const record = await readBoundedText(recordPath);
    if (!record.valid) return record;
    const instance = parsePreparedAgentInstance(record.text);
    if (instanceFileName(instance.instanceId) !== expectedFileName) return { valid: false };
    return { valid: true, instance };
  } catch {
    return { valid: false };
  }
};

const ensureInstancesDirectory = async (instancesDirectory: string): Promise<void> => {
  await mkdir(instancesDirectory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(instancesDirectory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new BuilderInstanceStoreError(
      'write',
      'The local Agent Instance directory is not a regular directory.',
    );
  }
};

const hasSafeInstancesDirectory = async (
  instancesDirectory: string,
  operation: 'discover' | 'read',
): Promise<boolean> => {
  let metadata;
  try {
    metadata = await lstat(instancesDirectory);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw new BuilderInstanceStoreError(
      operation,
      'The local Agent Instance directory could not be inspected.',
      { cause: error },
    );
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new BuilderInstanceStoreError(
      operation,
      'The local Agent Instance directory is not a regular directory.',
    );
  }
  return true;
};

const atomicWrite = async (
  instancesDirectory: string,
  fileName: string,
  contents: string,
): Promise<void> => {
  const targetPath = join(instancesDirectory, fileName);
  const temporaryPath = join(
    instancesDirectory,
    `.${fileName}.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let replaced = false;
  let failure: unknown;

  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
    replaced = true;
  } catch (error) {
    failure = error;
  }

  const cleanupFailures: unknown[] = [];
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (!replaced) {
    try {
      await rm(temporaryPath, { force: true });
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
}

export const createFileSystemBuilderInstanceStore = (
  options: FileSystemBuilderInstanceStoreOptions = {},
): BuilderInstanceStore => {
  const stateRoot = resolve(options.stateRoot ?? resolveBuilderStateRoot());
  const instancesDirectory = join(stateRoot, 'instances');

  return {
    async get(instanceId) {
      const fileName = instanceFileName(instanceId);
      if (!(await hasSafeInstancesDirectory(instancesDirectory, 'read'))) return undefined;
      const recordPath = join(instancesDirectory, fileName);
      let metadata;
      try {
        metadata = await lstat(recordPath);
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) return undefined;
        throw new BuilderInstanceStoreError(
          'read',
          'The local Agent Instance record could not be inspected.',
          { cause: error },
        );
      }
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new BuilderInstanceStoreError(
          'read',
          'The local Agent Instance record is not a regular file.',
        );
      }
      const record = await readRecord(recordPath, fileName);
      if (!record.valid) {
        throw new BuilderInstanceStoreError('read', 'The local Agent Instance record is invalid.');
      }
      return record.instance;
    },

    async put(instanceInput) {
      const instance = parsePreparedAgentInstance(instanceInput);
      const fileName = instanceFileName(instance.instanceId);
      try {
        await ensureInstancesDirectory(instancesDirectory);
        await atomicWrite(instancesDirectory, fileName, serializePreparedAgentInstance(instance));
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
      if (!(await hasSafeInstancesDirectory(instancesDirectory, 'discover'))) {
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
      try {
        const directory = await opendir(instancesDirectory);
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
        const record = await readRecord(join(instancesDirectory, fileName), fileName);
        if (record.valid) instances.push(record.instance);
        else invalidRecordCount += 1;
      }
      const warnings = [
        ...(invalidRecordCount === 0
          ? []
          : [
              `${String(invalidRecordCount)} local instance ${
                invalidRecordCount === 1 ? 'record is' : 'records are'
              } invalid and were not returned.`,
            ]),
        ...(truncated
          ? [`Local instance discovery inspected at most ${String(MAX_DISCOVERY_RECORDS)} records.`]
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
