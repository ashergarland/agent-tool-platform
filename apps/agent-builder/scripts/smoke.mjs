import {
  createBuilderApplication,
  listenBuilderApplication,
} from '../dist/server/server/application.js';
import { developerOptimizationPreset } from '../dist/server/shared/developer-optimization-preset.js';
import { LOCAL_VSCODE_ENVIRONMENT_ID } from '../dist/server/shared/contracts.js';

const application = await createBuilderApplication({ mode: 'production' });

try {
  const { origin } = await listenBuilderApplication(application, 0);
  const [healthResponse, pageResponse] = await Promise.all([
    fetch(`${origin}/api/health`),
    fetch(origin, { headers: { Accept: 'text/html' } }),
  ]);
  const health = await healthResponse.json();
  const page = await pageResponse.text();
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
    !healthResponse.ok ||
    health.status !== 'ok' ||
    !pageResponse.ok ||
    !page.includes('Agent Builder') ||
    !buildResponse.ok ||
    !prepareResponse.ok ||
    prepared.instance?.state !== 'NEEDS_SETUP' ||
    prepared.preparation?.runnable !== false ||
    prepared.build?.lockDigest !== build.lockDigest
  ) {
    throw new Error('Production Agent Builder smoke response was incomplete.');
  }
  process.stdout.write(`Agent Builder production smoke passed at ${origin}.\n`);
} finally {
  await application.close();
}
