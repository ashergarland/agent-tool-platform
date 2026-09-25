import {
  createBuilderApplication,
  listenBuilderApplication,
} from '../dist/server/server/application.js';

const application = await createBuilderApplication({ mode: 'production' });

try {
  const { origin } = await listenBuilderApplication(application, 0);
  const [healthResponse, pageResponse] = await Promise.all([
    fetch(`${origin}/api/health`),
    fetch(origin, { headers: { Accept: 'text/html' } }),
  ]);
  const health = await healthResponse.json();
  const page = await pageResponse.text();

  if (
    !healthResponse.ok ||
    health.status !== 'ok' ||
    !pageResponse.ok ||
    !page.includes('Agent Builder')
  ) {
    throw new Error('Production Agent Builder smoke response was incomplete.');
  }
  process.stdout.write(`Agent Builder production smoke passed at ${origin}.\n`);
} finally {
  await application.close();
}
