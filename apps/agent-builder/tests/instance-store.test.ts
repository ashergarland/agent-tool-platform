import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPreparedAgentInstanceIdentity,
  parsePreparedAgentInstance,
  serializePreparedAgentInstance,
  type AgentInstanceState,
  type PreparedAgentInstance,
} from '@agent-tool-platform/agent-kit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_TOOL_PLATFORM_STATE_DIR,
  BuilderInstanceStoreError,
  MAX_DISCOVERY_RECORDS,
  MAX_INSTANCE_RECORD_BYTES,
  createFileSystemBuilderInstanceStore,
  instanceFileName,
  resolveBuilderStateRoot,
} from '../src/server/instance-store.js';

const temporaryRoots: string[] = [];

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-builder-instance-store-'));
  temporaryRoots.push(root);
  return root;
};

const createFileSymlink = async (target: string, path: string): Promise<boolean> => {
  try {
    await symlink(target, path, 'file');
    return true;
  } catch (error) {
    const permissionUnavailable =
      error instanceof Error &&
      'code' in error &&
      (error.code === 'EPERM' || error.code === 'EACCES');
    if (permissionUnavailable && process.env['ATP_SYMLINK_TESTS_REQUIRED'] !== '1') return false;
    throw error;
  }
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;

const preparedInstance = ({
  environmentId = 'test-environment',
  lockCharacter = 'b',
  preparedAt = '2026-09-27T12:00:00.000Z',
  state = 'NEEDS_SETUP',
}: {
  readonly environmentId?: string;
  readonly lockCharacter?: string;
  readonly preparedAt?: string;
  readonly state?: AgentInstanceState;
} = {}): PreparedAgentInstance => {
  const seam = {
    schemaVersion: 1 as const,
    agentDefinition: {
      id: 'test-agent',
      version: '1.0.0',
      digest: digest('a'),
    },
    build: { lockDigest: digest(lockCharacter) },
    host: { id: 'vscode', adapterSchemaVersion: 2 },
    bindings: [
      {
        key: 'test-capability@1.0.0#local-package',
        capabilityId: 'test-capability',
        capabilityVersion: '1.0.0',
        profileId: 'local-package',
        mode: 'local' as const,
      },
    ],
  };
  const identity = createPreparedAgentInstanceIdentity(seam, environmentId);
  return parsePreparedAgentInstance({
    schemaVersion: 1,
    instanceId: identity.instanceId,
    environmentId,
    agentDefinition: seam.agentDefinition,
    build: seam.build,
    host: seam.host,
    preparedAt,
    state,
    bindings: seam.bindings.map((binding) => ({
      ...binding,
      state,
      readiness: state === 'READY' ? 'available-local' : 'local-setup-required',
    })),
  });
};

describe('Builder filesystem Agent Instance store', () => {
  it('uses the configured state root and a Windows-safe filename', async () => {
    const root = await temporaryRoot();
    const instance = preparedInstance();
    const fileName = instanceFileName(instance.instanceId);

    expect(resolveBuilderStateRoot({ [AGENT_TOOL_PLATFORM_STATE_DIR]: root }, 'unused-home')).toBe(
      root,
    );
    expect(resolveBuilderStateRoot({}, join(root, 'home'))).toBe(
      join(root, 'home', '.agent-tool-platform'),
    );
    expect(fileName).toMatch(/^[0-9a-f]{64}\.json$/u);
    expect(fileName).not.toContain(':');
  });

  it('atomically creates a canonical serialize/parse round-trip', async () => {
    const root = await temporaryRoot();
    const store = createFileSystemBuilderInstanceStore({ stateRoot: root });
    const instance = preparedInstance();

    await store.put(instance);

    const files = await readdir(join(root, 'instances'));
    expect(files).toEqual([instanceFileName(instance.instanceId)]);
    const record = await readFile(join(root, 'instances', files[0]!), 'utf8');
    expect(record).toBe(serializePreparedAgentInstance(instance));
    await expect(store.get(instance.instanceId)).resolves.toEqual(instance);
  });

  it('atomically replaces the same instance and leaves no temporary record', async () => {
    const root = await temporaryRoot();
    const store = createFileSystemBuilderInstanceStore({ stateRoot: root });
    const first = preparedInstance();
    const updated = preparedInstance({
      preparedAt: '2026-09-27T13:00:00.000Z',
      state: 'READY',
    });

    await store.put(first);
    await store.put(updated);

    const files = await readdir(join(root, 'instances'));
    expect(files).toEqual([instanceFileName(first.instanceId)]);
    expect(files.every((file) => !file.endsWith('.tmp'))).toBe(true);
    await expect(store.get(first.instanceId)).resolves.toEqual(updated);
  });

  it('creates a second file for a distinct Agent Kit instance identity', async () => {
    const root = await temporaryRoot();
    const store = createFileSystemBuilderInstanceStore({ stateRoot: root });
    const first = preparedInstance();
    const second = preparedInstance({ lockCharacter: 'c' });

    await store.put(first);
    await store.put(second);

    expect(first.instanceId).not.toBe(second.instanceId);
    expect(await readdir(join(root, 'instances'))).toHaveLength(2);
    await expect(store.list()).resolves.toMatchObject({
      instances: expect.arrayContaining([
        expect.objectContaining({ instanceId: first.instanceId }),
        expect.objectContaining({ instanceId: second.instanceId }),
      ]),
    });
  });

  it('strictly isolates malformed, mismatched, and unexpected record types', async () => {
    const root = await temporaryRoot();
    const store = createFileSystemBuilderInstanceStore({ stateRoot: root });
    const valid = preparedInstance();
    await store.put(valid);
    const instancesDirectory = join(root, 'instances');
    await writeFile(join(instancesDirectory, `${'c'.repeat(64)}.json`), '{not-json', 'utf8');
    await writeFile(
      join(instancesDirectory, `${'d'.repeat(64)}.json`),
      serializePreparedAgentInstance(preparedInstance({ environmentId: 'mismatch' })),
      'utf8',
    );
    await mkdir(join(instancesDirectory, `${'e'.repeat(64)}.json`));
    await writeFile(join(instancesDirectory, '.ignored-record.tmp'), 'ignored', 'utf8');

    const discovery = await store.list();

    expect(discovery.instances).toEqual([valid]);
    expect(discovery.diagnostics).toMatchObject({
      inspectedRecordCount: 4,
      invalidRecordCount: 3,
      truncated: false,
    });
    expect(discovery.diagnostics.warnings).toEqual([
      '3 local instance records are invalid and were not returned.',
    ]);
  });

  it('orders by preparedAt descending and instanceId by code unit on ties', async () => {
    const root = await temporaryRoot();
    const store = createFileSystemBuilderInstanceStore({ stateRoot: root });
    const older = preparedInstance({
      environmentId: 'older',
      preparedAt: '2026-09-27T11:00:00.000Z',
    });
    const tied = [
      preparedInstance({ environmentId: 'tie-a' }),
      preparedInstance({ environmentId: 'tie-b' }),
    ].sort((left, right) =>
      left.instanceId < right.instanceId ? -1 : left.instanceId > right.instanceId ? 1 : 0,
    );
    await store.put(tied[1]!);
    await store.put(older);
    await store.put(tied[0]!);

    const discovery = await store.list();

    expect(discovery.instances.map(({ instanceId }) => instanceId)).toEqual([
      tied[0]!.instanceId,
      tied[1]!.instanceId,
      older.instanceId,
    ]);
  });

  it('rejects an oversized record without reading it as a valid instance', async () => {
    const root = await temporaryRoot();
    const instancesDirectory = join(root, 'instances');
    await mkdir(instancesDirectory, { recursive: true });
    await writeFile(
      join(instancesDirectory, `${'f'.repeat(64)}.json`),
      Buffer.alloc(MAX_INSTANCE_RECORD_BYTES + 1, 0x20),
    );
    const store = createFileSystemBuilderInstanceStore({ stateRoot: root });

    const discovery = await store.list();

    expect(discovery.instances).toEqual([]);
    expect(discovery.diagnostics.invalidRecordCount).toBe(1);
  });

  it('bounds the number of canonical-looking records inspected', async () => {
    const root = await temporaryRoot();
    const instancesDirectory = join(root, 'instances');
    await mkdir(instancesDirectory, { recursive: true });
    await Promise.all(
      Array.from({ length: MAX_DISCOVERY_RECORDS + 1 }, async (_, index) => {
        const name = index.toString(16).padStart(64, '0');
        await writeFile(join(instancesDirectory, `${name}.json`), '{}', 'utf8');
      }),
    );
    const store = createFileSystemBuilderInstanceStore({ stateRoot: root });

    const discovery = await store.list();

    expect(discovery.diagnostics).toMatchObject({
      inspectedRecordCount: MAX_DISCOVERY_RECORDS,
      invalidRecordCount: MAX_DISCOVERY_RECORDS,
      truncated: true,
    });
    expect(discovery.diagnostics.warnings).toHaveLength(2);
  });

  it('does not follow a canonical-looking symlink outside the instance directory', async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const store = createFileSystemBuilderInstanceStore({ stateRoot: root });
    const valid = preparedInstance();
    await store.put(valid);
    const linkedName = `${'1'.repeat(64)}.json`;
    await symlink(
      outside,
      join(root, 'instances', linkedName),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const discovery = await store.list();

    expect(discovery.instances).toEqual([valid]);
    expect(discovery.diagnostics.invalidRecordCount).toBe(1);
    await expect(store.get(digest('1'))).rejects.toBeInstanceOf(BuilderInstanceStoreError);
  });

  it('rejects an instances directory that is itself a symlink', async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await symlink(
      outside,
      join(root, 'instances'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const store = createFileSystemBuilderInstanceStore({ stateRoot: root });

    await expect(store.list()).rejects.toBeInstanceOf(BuilderInstanceStoreError);
    await expect(store.put(preparedInstance())).rejects.toBeInstanceOf(BuilderInstanceStoreError);
  });

  it('reads bounded contents from the validated descriptor after its path is replaced', async () => {
    const root = await temporaryRoot();
    const original = preparedInstance();
    const replacement = preparedInstance({
      preparedAt: '2026-09-27T13:00:00.000Z',
      state: 'READY',
    });
    const initialStore = createFileSystemBuilderInstanceStore({ stateRoot: root });
    await initialStore.put(original);
    const movedPath = join(root, 'instances', '.opened-record');
    let replaced = false;
    const store = createFileSystemBuilderInstanceStore({
      stateRoot: root,
      fileSystemHooks: {
        afterReadDescriptorValidated: async (recordPath) => {
          if (replaced) return;
          replaced = true;
          await rename(recordPath, movedPath);
          await writeFile(recordPath, serializePreparedAgentInstance(replacement), 'utf8');
        },
      },
    });

    await expect(store.get(original.instanceId)).resolves.toEqual(original);
    expect(replaced).toBe(true);
    expect(
      parsePreparedAgentInstance(
        await readFile(join(root, 'instances', instanceFileName(original.instanceId)), 'utf8'),
      ),
    ).toEqual(replacement);
  });

  it('verifies temporary-file identity and detects path replacement before rename', async () => {
    const root = await temporaryRoot();
    const original = preparedInstance();
    const updated = preparedInstance({
      preparedAt: '2026-09-27T13:00:00.000Z',
      state: 'READY',
    });
    const initialStore = createFileSystemBuilderInstanceStore({ stateRoot: root });
    await initialStore.put(original);
    let temporaryIdentityChecked = false;
    const store = createFileSystemBuilderInstanceStore({
      stateRoot: root,
      fileSystemHooks: {
        afterTemporaryFileValidated: async (temporaryPath) => {
          const descriptor = await open(temporaryPath, 'r');
          try {
            const opened = await descriptor.stat({ bigint: true });
            const addressed = await lstat(temporaryPath, { bigint: true });
            expect(opened.dev).not.toBe(0n);
            expect(opened.ino).not.toBe(0n);
            expect(addressed.dev).toBe(opened.dev);
            expect(addressed.ino).toBe(opened.ino);
            temporaryIdentityChecked = true;
          } finally {
            await descriptor.close();
          }
          await rename(temporaryPath, `${temporaryPath}.moved`);
          await writeFile(temporaryPath, serializePreparedAgentInstance(updated), 'utf8');
        },
      },
    });

    await expect(store.put(updated)).rejects.toBeInstanceOf(BuilderInstanceStoreError);
    expect(temporaryIdentityChecked).toBe(true);
    await expect(initialStore.get(original.instanceId)).resolves.toEqual(original);
  });

  it('preserves the old record and removes its temporary file on a pre-rename failure', async () => {
    const root = await temporaryRoot();
    const original = preparedInstance();
    const updated = preparedInstance({
      preparedAt: '2026-09-27T13:00:00.000Z',
      state: 'READY',
    });
    const initialStore = createFileSystemBuilderInstanceStore({ stateRoot: root });
    await initialStore.put(original);
    const store = createFileSystemBuilderInstanceStore({
      stateRoot: root,
      fileSystemHooks: {
        beforeAtomicReplace: () => {
          throw new Error('injected pre-rename failure');
        },
      },
    });

    await expect(store.put(updated)).rejects.toBeInstanceOf(BuilderInstanceStoreError);
    await expect(initialStore.get(original.instanceId)).resolves.toEqual(original);
    expect(
      (await readdir(join(root, 'instances'))).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('rejects a stable target reparse point before replacement', async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const instance = preparedInstance();
    const instancesDirectory = join(root, 'instances');
    await mkdir(instancesDirectory, { recursive: true });
    await symlink(
      outside,
      join(instancesDirectory, instanceFileName(instance.instanceId)),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const store = createFileSystemBuilderInstanceStore({ stateRoot: root });

    await expect(store.put(instance)).rejects.toBeInstanceOf(BuilderInstanceStoreError);
  });

  it('rejects stable file symlink records and targets when supported', async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const instance = preparedInstance();
    const instancesDirectory = join(root, 'instances');
    await mkdir(instancesDirectory, { recursive: true });
    const outsideRecord = join(outside, 'outside-record.json');
    await writeFile(outsideRecord, serializePreparedAgentInstance(instance), 'utf8');
    const linkedRecord = join(instancesDirectory, `${'1'.repeat(64)}.json`);
    if (!(await createFileSymlink(outsideRecord, linkedRecord))) return;
    const store = createFileSystemBuilderInstanceStore({ stateRoot: root });

    await expect(store.get(digest('1'))).rejects.toBeInstanceOf(BuilderInstanceStoreError);
    await rm(linkedRecord);
    expect(
      await createFileSymlink(
        outsideRecord,
        join(instancesDirectory, instanceFileName(instance.instanceId)),
      ),
    ).toBe(true);
    await expect(store.put(instance)).rejects.toBeInstanceOf(BuilderInstanceStoreError);
  });

  it('detects replacement of the instances directory before the final rename', async () => {
    const root = await temporaryRoot();
    const movedDirectory = join(root, 'moved-instances');
    const store = createFileSystemBuilderInstanceStore({
      stateRoot: root,
      fileSystemHooks: {
        beforeAtomicReplace: async () => {
          await rename(join(root, 'instances'), movedDirectory);
          await mkdir(join(root, 'instances'));
        },
      },
    });

    await expect(store.put(preparedInstance())).rejects.toBeInstanceOf(BuilderInstanceStoreError);
    expect(await readdir(join(root, 'instances'))).toEqual([]);
  });

  it.runIf(process.platform === 'win32')(
    'uses non-zero matching Windows identity and replaces a record normally',
    async () => {
      const root = await temporaryRoot();
      const original = preparedInstance();
      const updated = preparedInstance({
        preparedAt: '2026-09-27T13:00:00.000Z',
        state: 'READY',
      });
      const store = createFileSystemBuilderInstanceStore({ stateRoot: root });
      await store.put(original);
      await store.put(updated);
      const recordPath = join(root, 'instances', instanceFileName(original.instanceId));
      const descriptor = await open(recordPath, 'r');
      try {
        const opened = await descriptor.stat({ bigint: true });
        const addressed = await lstat(recordPath, { bigint: true });
        expect(opened.dev).not.toBe(0n);
        expect(opened.ino).not.toBe(0n);
        expect(addressed.dev).toBe(opened.dev);
        expect(addressed.ino).toBe(opened.ino);
      } finally {
        await descriptor.close();
      }
      await expect(store.get(original.instanceId)).resolves.toEqual(updated);
      expect(await readFile(recordPath, 'utf8')).toBe(serializePreparedAgentInstance(updated));
    },
  );

  it('stores only the canonical PreparedAgentInstance privacy surface', async () => {
    const root = await temporaryRoot();
    const store = createFileSystemBuilderInstanceStore({ stateRoot: root });
    const instance = preparedInstance();
    await store.put(instance);
    const record = await readFile(
      join(root, 'instances', instanceFileName(instance.instanceId)),
      'utf8',
    );

    expect(record).not.toContain('canonical agent instructions');
    expect(record).not.toContain('https://private.example.test');
    expect(record).not.toContain('actual-secret-value');
    expect(record).not.toContain(root);
    expect(record).not.toContain('.github/agents/test-agent.agent.md');
    expect(record).not.toContain('"lastActiveAt"');
    expect(record).not.toContain('"telemetry"');
  });
});
