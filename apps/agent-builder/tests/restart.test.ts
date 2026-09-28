import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePreparedAgentInstance } from '@agent-tool-platform/agent-kit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFileSystemBuilderInstanceStore,
  instanceFileName,
} from '../src/server/instance-store.js';
import { createBuilderService } from '../src/server/service.js';
import { LOCAL_VSCODE_ENVIRONMENT_ID } from '../src/shared/contracts.js';
import { developerOptimizationPreset } from '../src/shared/developer-optimization-preset.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Local Agent Instance restart discovery', () => {
  it('rediscovers and updates the same H7 instance through a recreated Builder service', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'agent-builder-restart-'));
    temporaryRoots.push(stateRoot);
    const firstService = createBuilderService({
      instanceStore: createFileSystemBuilderInstanceStore({ stateRoot }),
    });
    const build = await firstService.buildAgent(developerOptimizationPreset);
    const first = await firstService.prepareAgent({
      definition: developerOptimizationPreset,
      expectedLockDigest: build.lockDigest,
      environmentId: LOCAL_VSCODE_ENVIRONMENT_ID,
    });

    expect(first.preparation.disposition).toBe('created');
    expect(first.instance.state).toBe('NEEDS_SETUP');
    const firstFiles = await readdir(join(stateRoot, 'instances'));
    expect(firstFiles).toEqual([instanceFileName(first.instance.instanceId)]);

    const secondService = createBuilderService({
      instanceStore: createFileSystemBuilderInstanceStore({ stateRoot }),
    });
    const afterRestart = await secondService.listInstances();
    expect(afterRestart.instances).toHaveLength(1);
    expect(afterRestart.instances[0]).toMatchObject({
      instanceId: first.instance.instanceId,
      preparedAt: first.instance.preparedAt,
      state: 'NEEDS_SETUP',
      bindingSummary: { local: 6, remote: 1, hybrid: 0, total: 7 },
    });

    const second = await secondService.prepareAgent({
      definition: developerOptimizationPreset,
      expectedLockDigest: build.lockDigest,
      environmentId: LOCAL_VSCODE_ENVIRONMENT_ID,
    });
    expect(second.preparation.disposition).toBe('updated');
    expect(second.instance.instanceId).toBe(first.instance.instanceId);
    expect(await readdir(join(stateRoot, 'instances'))).toEqual(firstFiles);

    const recordText = await readFile(join(stateRoot, 'instances', firstFiles[0]!), 'utf8');
    const record = parsePreparedAgentInstance(recordText);
    expect(record.instanceId).toBe(first.instance.instanceId);
    expect(record.preparedAt).toBe(second.instance.preparedAt);
    expect(record.state).toBe('NEEDS_SETUP');
    expect(recordText).not.toContain(developerOptimizationPreset.instructions);
    expect(recordText).not.toContain('${input:azure-endpoint}');
    expect(recordText).not.toContain('connector-api-key');
    expect(recordText).not.toContain('.github/agents/developer-optimization.agent.md');
    expect(recordText).not.toContain(stateRoot);
  });
});
