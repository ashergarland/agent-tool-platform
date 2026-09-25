import {
  createBuilderApplication,
  DEFAULT_BUILDER_PORT,
  listenBuilderApplication,
} from './application.js';

const parsePort = (): number => {
  const portArgument = process.argv.find((argument) => argument.startsWith('--port='));
  const raw = portArgument?.slice('--port='.length) ?? process.env['AGENT_BUILDER_PORT'];
  if (raw === undefined) return DEFAULT_BUILDER_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('AGENT_BUILDER_PORT must be an integer from 1 through 65535.');
  }
  return port;
};

const development = process.argv.includes('--dev');
const application = await createBuilderApplication({
  mode: development ? 'development' : 'production',
});
const address = await listenBuilderApplication(application, parsePort());

process.stdout.write(`Agent Builder ready at ${address.origin}\n`);

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await application.close();
};

process.once('SIGINT', () => {
  void stop().then(() => process.exit(0));
});
process.once('SIGTERM', () => {
  void stop().then(() => process.exit(0));
});
