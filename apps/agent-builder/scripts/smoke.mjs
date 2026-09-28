import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createBuilderApplication,
  listenBuilderApplication,
} from '../dist/server/server/application.js';
import { developerOptimizationPreset } from '../dist/server/shared/developer-optimization-preset.js';
import { LOCAL_VSCODE_ENVIRONMENT_ID } from '../dist/server/shared/contracts.js';

const stateRoot = await mkdtemp(join(tmpdir(), 'agent-builder-smoke-'));
const previousStateRoot = process.env['AGENT_TOOL_PLATFORM_STATE_DIR'];
process.env['AGENT_TOOL_PLATFORM_STATE_DIR'] = stateRoot;

const withApplication = async (run) => {
  const application = await createBuilderApplication({ mode: 'production' });
  try {
    const address = await listenBuilderApplication(application, 0);
    return await run(address.origin);
  } finally {
    await application.close();
  }
};

try {
  const first = await withApplication(async (origin) => {
    const [healthResponse, pageResponse, emptyDiscoveryResponse] = await Promise.all([
      fetch(`${origin}/api/health`),
      fetch(origin, { headers: { Accept: 'text/html' } }),
      fetch(`${origin}/api/instances`),
    ]);
    const health = await healthResponse.json();
    const page = await pageResponse.text();
    const emptyDiscovery = await emptyDiscoveryResponse.json();
    const buildResponse = await fetch(`${origin}/api/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: developerOptimizationPreset }),
    });
    const build = await buildResponse.json();
    const prepareResponse = await fetch(`${origin}/api/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        definition: developerOptimizationPreset,
        expectedLockDigest: build.lockDigest,
        environmentId: LOCAL_VSCODE_ENVIRONMENT_ID,
      }),
    });
    const prepared = await prepareResponse.json();
    const discoveryResponse = await fetch(`${origin}/api/instances`);
    const discovery = await discoveryResponse.json();

    if (
      !healthResponse.ok ||
      health.status !== 'ok' ||
      !pageResponse.ok ||
      !page.includes('Agent Builder') ||
      !emptyDiscoveryResponse.ok ||
      emptyDiscovery.instances?.length !== 0 ||
      !buildResponse.ok ||
      !prepareResponse.ok ||
      prepared.instance?.state !== 'NEEDS_SETUP' ||
      prepared.preparation?.runnable !== false ||
      prepared.preparation?.disposition !== 'created' ||
      prepared.build?.lockDigest !== build.lockDigest ||
      !discoveryResponse.ok ||
      discovery.instances?.length !== 1 ||
      discovery.instances[0]?.instanceId !== prepared.instance?.instanceId
    ) {
      throw new Error('Initial production Agent Builder smoke response was incomplete.');
    }
    return { build, prepared };
  });

  const second = await withApplication(async (origin) => {
    const discoveryResponse = await fetch(`${origin}/api/instances`);
    const discovery = await discoveryResponse.json();
    const buildResponse = await fetch(`${origin}/api/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: developerOptimizationPreset }),
    });
    const build = await buildResponse.json();
    const prepareResponse = await fetch(`${origin}/api/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        definition: developerOptimizationPreset,
        expectedLockDigest: build.lockDigest,
        environmentId: LOCAL_VSCODE_ENVIRONMENT_ID,
      }),
    });
    const prepared = await prepareResponse.json();

    if (
      !discoveryResponse.ok ||
      discovery.instances?.length !== 1 ||
      discovery.instances[0]?.instanceId !== first.prepared.instance?.instanceId ||
      !prepareResponse.ok ||
      prepared.preparation?.disposition !== 'updated' ||
      prepared.instance?.instanceId !== first.prepared.instance?.instanceId
    ) {
      throw new Error('Restart production Agent Builder smoke response was incomplete.');
    }
    return prepared;
  });

  const files = await readdir(join(stateRoot, 'instances'));
  if (
    second.instance?.instanceId !== first.prepared.instance?.instanceId ||
    files.length !== 1 ||
    files[0]?.includes(':')
  ) {
    throw new Error('Production Agent Builder smoke persistence was not canonical.');
  }
  process.stdout.write('Agent Builder production persistence/restart smoke passed.\n');
} finally {
  if (previousStateRoot === undefined) delete process.env['AGENT_TOOL_PLATFORM_STATE_DIR'];
  else process.env['AGENT_TOOL_PLATFORM_STATE_DIR'] = previousStateRoot;
  await rm(stateRoot, { recursive: true, force: true });
}
